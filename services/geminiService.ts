import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AUDIO_WORKLET_CODE, float32ToInt16, base64ToUint8Array, decodeAudioData, downsampleBuffer, arrayBufferToBase64 } from "../utils/audioUtils";
import { ConnectionStatus, Marker, CameraCommand } from "../types";

const TOOL_CALL_REGEX = /<call:(\w+)\s*({[\s\S]*?})\s*\/>/g;

export class GeminiService {
  private ai: GoogleGenAI | null = null;
  private session: any = null;
  private audioContext: AudioContext | null = null;
  private inputWorklet: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private frequencyData: Uint8Array | null = null;
  private stream: MediaStream | null = null;
  
  // Audio Queue Management
  private nextStartTime: number = 0;
  private activeSources: { source: AudioBufferSourceNode, gain: GainNode }[] = []; 
  private currentTurnVersion = 0; 
  private processingQueue: Promise<void> = Promise.resolve(); 
  private sendingQueue: Promise<void> = Promise.resolve(); // Queue for outgoing WebSocket messages

  private apiKey: string;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  
  private inputBuffer: Float32Array = new Float32Array(0);
  private readonly CHUNK_SIZE = 1024; 
  
  private currentUserTranscript = "";
  private currentAiTranscript = "";
  
  // Commands that trigger immediate stop
  private readonly STOP_KEYWORDS = ['стоп', 'стой', 'остановись', 'хватит', 'тихо', 'замолчи'];

  public onStatusChange: (status: ConnectionStatus) => void = () => {};
  public onAudioLevel: (level: number) => void = () => {};
  public onMarkerUpdate: (markers: Marker[], action: string) => void = () => {};
  public onTranscript: (text: string, source: 'user' | 'ai', isFinal: boolean) => void = () => {};
  public onCameraCommand: (cmd: CameraCommand) => void = () => {};

  constructor() {
    this.apiKey = process.env.API_KEY || '';
    if (this.apiKey) {
        // Increase timeout to 60 seconds (60000ms) to prevent premature timeouts
        // @ts-ignore - timeout might not be in the type definition but is supported by the underlying fetch
        this.ai = new GoogleGenAI({ apiKey: this.apiKey, timeout: 60000 });
    }
  }

  public async connect() {
    this.shouldReconnect = true;
    this.currentUserTranscript = "";
    this.currentAiTranscript = "";
    
    try {
        // Initialize AudioContext immediately to allow user gesture if needed
        this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ 
            sampleRate: 24000,
            latencyHint: 'interactive'
        });
        
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
    } catch (e) {
        console.error("AudioContext Init Error:", e);
    }

    if (!this.ai) {
        this.onStatusChange(ConnectionStatus.ERROR);
        return;
    }

    this.onStatusChange(ConnectionStatus.CONNECTING);

    try {
      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
            onopen: this.handleOpen.bind(this),
            onmessage: this.handleMessage.bind(this),
            onclose: this.handleClose.bind(this),
            onerror: (err: any) => {
                console.error("Gemini Error:", err);
            }
        },
        config: {
            responseModalities: [Modality.AUDIO], 
            // Fixed: removed 'model' property which caused Invalid Argument error
            inputAudioTranscription: {}, 
            outputAudioTranscription: {},
            systemInstruction: `Ты — тактический ИИ "VisionOS". 
            
            ТВОИ ЗАДАЧИ:
            1. Визуальный анализ: Используй видеопоток, чтобы понимать контекст.
            2. Стиль: Краткий, четкий, профессиональный. Используй термины: "Цель", "Объект", "Вероятно", "Угроза".
            3. Язык: ТОЛЬКО РУССКИЙ.
            4. РЕЧЕВОЙ ПРОТОКОЛ: Твоя речь должна быть непрерывной. Если ты слышишь шум или голос пользователя, НЕ ПРЕРЫВАЙСЯ и НЕ ОСТАНАВЛИВАЙСЯ, пока тебя не попросят замолчать командами "Стоп" или "Стой".

            ИНСТРУМЕНТЫ:
            - <call:camera_zoom {"level": 2.0} />
            - <call:set_filter {"type": "person"} />
            
            ВАЖНО: Никогда не отправляй "технический" текст анализа изображения в ответ. Только реплики диалога.`,
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
            }
        }
      };

      this.session = null;
      this.session = await this.ai.live.connect(config);
      
    } catch (e) {
      console.error("Connection Error", e);
      this.onStatusChange(ConnectionStatus.ERROR);
      this.handleClose(); 
    }
  }

  private async handleOpen() {
    console.log("Gemini Connected");
    this.reconnectAttempts = 0;
    this.onStatusChange(ConnectionStatus.CONNECTED);
    await this.startAudioInput();
  }

  private handleClose() {
    if (!this.shouldReconnect) {
        this.onStatusChange(ConnectionStatus.DISCONNECTED);
        return;
    }
    
    this.onStatusChange(ConnectionStatus.CONNECTING);
    this.session = null; 
    
    this.stopAllAudio();
    if (this.audioContext) {
        try { this.audioContext.close(); } catch(e) {}
        this.audioContext = null;
    }
    
    const baseDelay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    const delay = baseDelay + (Math.random() * 1000);

    setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
    }, delay);
  }

  private async handleMessage(message: LiveServerMessage) {
    if (message.serverContent?.interrupted) {
        return;
    }

    const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData && this.audioContext) {
      this.processingQueue = this.processingQueue
        .then(() => this.scheduleAudioChunk(audioData))
        .catch(e => console.error("Audio scheduling error", e));
    }

    const serverContent = message.serverContent;
    if (serverContent) {
        if (serverContent.outputTranscription?.text) {
             const text = serverContent.outputTranscription.text;
             this.parseHeuristicToolCalls(text);
             this.currentAiTranscript += text;
             this.onTranscript(this.currentAiTranscript, 'ai', false);
        }
        
        if (serverContent.inputTranscription?.text) {
             const text = serverContent.inputTranscription.text;
             this.currentUserTranscript += text;
             this.onTranscript(this.currentUserTranscript, 'user', false);

             const lowerText = text.toLowerCase();
             const isStopCommand = this.STOP_KEYWORDS.some(keyword => lowerText.includes(keyword));
             
             if (isStopCommand) {
                 console.log("VisionOS: STOP COMMAND DETECTED");
                 this.stopAllAudio();
                 this.processingQueue = Promise.resolve(); 
                 if (this.currentAiTranscript) {
                     this.onTranscript(this.currentAiTranscript, 'ai', true);
                     this.currentAiTranscript = "";
                 }
             }
        }

        if (serverContent.turnComplete) {
            if (this.currentUserTranscript.trim()) {
                this.onTranscript(this.currentUserTranscript, 'user', true);
            }
            this.currentUserTranscript = "";

            if (this.currentAiTranscript.trim()) {
                this.onTranscript(this.currentAiTranscript, 'ai', true);
            }
            this.currentAiTranscript = "";
        }
    }
  }

  private stopAllAudio() {
      this.currentTurnVersion++;
      this.activeSources.forEach(({ source, gain }) => {
          try { 
              const currTime = this.audioContext?.currentTime || 0;
              gain.gain.cancelScheduledValues(currTime);
              gain.gain.setValueAtTime(gain.gain.value, currTime);
              gain.gain.linearRampToValueAtTime(0, currTime + 0.05); 
              source.stop(currTime + 0.05); 
          } catch(e) {}
      });
      this.activeSources = [];
      
      if (this.audioContext) {
          this.nextStartTime = this.audioContext.currentTime + 0.05;
      }
  }

  private async scheduleAudioChunk(base64Data: string) {
    const localVersion = this.currentTurnVersion;
    if (!this.audioContext) return;

    try {
        const audioBytes = base64ToUint8Array(base64Data);
        const buffer = await decodeAudioData(audioBytes, this.audioContext, 24000);
        
        if (localVersion !== this.currentTurnVersion) return;

        const source = this.audioContext.createBufferSource();
        const gainNode = this.audioContext.createGain();
        
        source.buffer = buffer;
        source.connect(gainNode);
        gainNode.connect(this.audioContext.destination);
        
        const currentTime = this.audioContext.currentTime;
        
        if (this.nextStartTime < currentTime) {
             this.nextStartTime = currentTime + 0.01;
        }

        const startTime = this.nextStartTime;
        
        gainNode.gain.setValueAtTime(1, startTime);
        source.start(startTime);
        
        this.nextStartTime += buffer.duration;

        const sourceObj = { source, gain: gainNode };
        this.activeSources.push(sourceObj);
        
        source.onended = () => {
            this.activeSources = this.activeSources.filter(s => s !== sourceObj);
        };

    } catch (e) {
        console.error("Error scheduling audio chunk", e);
    }
  }

  private parseHeuristicToolCalls(text: string) {
    let match;
    while ((match = TOOL_CALL_REGEX.exec(text)) !== null) {
        try {
            const funcName = match[1];
            let jsonStr = match[2];
            jsonStr = jsonStr.replace(/(\w+):/g, '"$1":');
            const payload = JSON.parse(jsonStr);

            if (funcName === 'camera_zoom') {
                this.onCameraCommand({ type: 'zoom', value: payload.level || 1 });
            } else if (funcName === 'set_filter') {
                this.onCameraCommand({ type: 'filter', value: payload.type || 'all' });
            }
        } catch (e) { /* Safe fail */ }
    }
  }

  private async startAudioInput() {
    try {
      if (!this.audioContext) return;
      if (this.audioContext.state === 'suspended') {
          await this.audioContext.resume();
      }

      // Check again after async resume
      if (!this.audioContext) return;

      this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
      }});
      
      // Check again after async getUserMedia (context might be closed via disconnect)
      if (!this.audioContext) return;

      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.3; 
      this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);

      const blob = new Blob([AUDIO_WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      
      try {
        await this.audioContext.audioWorklet.addModule(workletUrl);
      } catch (e) {
         // Module might already be added, ignore
      }

      // Check again after async addModule
      if (!this.audioContext) return;
      
      this.inputWorklet = new AudioWorkletNode(this.audioContext, 'mic-processor');
      this.inputWorklet.port.onmessage = (event) => {
        const inputData = event.data as Float32Array;
        let sum = 0;
        for (let i = 0; i < inputData.length; i += 10) sum += inputData[i] * inputData[i];
        const rms = Math.sqrt(sum / (inputData.length / 10));
        this.onAudioLevel(rms * 100); 
        this.processInputAudio(inputData, rms);
      };

      source.connect(this.analyser);
      this.analyser.connect(this.inputWorklet);
      this.inputWorklet.connect(this.audioContext.destination);

    } catch (e) {
      console.error("Mic Error", e);
    }
  }

  private processInputAudio(chunk: Float32Array, rms: number) {
      if (!this.audioContext) return;

      const resampled = downsampleBuffer(chunk, this.audioContext.sampleRate, 16000);
      const newBuffer = new Float32Array(this.inputBuffer.length + resampled.length);
      newBuffer.set(this.inputBuffer);
      newBuffer.set(resampled, this.inputBuffer.length);
      this.inputBuffer = newBuffer;

      while (this.inputBuffer.length >= this.CHUNK_SIZE) {
          const chunkToSend = this.inputBuffer.slice(0, this.CHUNK_SIZE);
          this.inputBuffer = this.inputBuffer.slice(this.CHUNK_SIZE);
          
          if (this.session) {
              const pcmInt16 = float32ToInt16(chunkToSend);
              const base64 = arrayBufferToBase64(pcmInt16.buffer);
              
              this.sendingQueue = this.sendingQueue.then(() => {
                  return this.session.sendRealtimeInput({ 
                      media: { mimeType: "audio/pcm;rate=16000", data: base64 } 
                  });
              }).catch(e => {
                  // Silent catch for send errors
              });
          }
      }
  }

  public getAudioSpectrum(): Uint8Array | null {
    if (this.analyser && this.frequencyData) {
        this.analyser.getByteFrequencyData(this.frequencyData);
        return this.frequencyData;
    }
    return null;
  }

  public sendVideoFrame(base64Image: string) {
    if (this.session) {
        this.sendingQueue = this.sendingQueue.then(() => {
            return this.session.sendRealtimeInput({
                media: { mimeType: 'image/jpeg', data: base64Image }
            });
        }).catch(e => {});
    }
  }

  public disconnect() {
    this.shouldReconnect = false;
    this.stopAllAudio();
    if (this.stream) this.stream.getTracks().forEach(track => track.stop());
    if (this.audioContext) {
        try { this.audioContext.close(); } catch(e) {}
        this.audioContext = null;
    }
    this.session = null;
    this.processingQueue = Promise.resolve();
    this.sendingQueue = Promise.resolve();
    this.onStatusChange(ConnectionStatus.DISCONNECTED);
  }
}