
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
  private activeSources: AudioBufferSourceNode[] = []; 
  private currentTurnVersion = 0; // To invalidate stale async audio

  private apiKey: string;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  
  // Audio Buffering State
  private inputBuffer: Float32Array = new Float32Array(0);
  // Reduced chunk size for faster interruption detection (64ms @ 16kHz)
  private readonly CHUNK_SIZE = 1024; 
  
  // Voice Activity Detection (Noise Gate)
  private readonly NOISE_THRESHOLD = 0.005; 
  private silenceCounter = 0;

  public onStatusChange: (status: ConnectionStatus) => void = () => {};
  public onAudioLevel: (level: number) => void = () => {};
  public onMarkerUpdate: (markers: Marker[], action: string) => void = () => {};
  public onTranscript: (text: string, isFinal: boolean) => void = () => {};
  public onCameraCommand: (cmd: CameraCommand) => void = () => {};

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    if (this.apiKey) {
        this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    }
  }

  public updateApiKey(key: string) {
    this.apiKey = key;
    this.ai = new GoogleGenAI({ apiKey: this.apiKey });
  }

  public async connect() {
    this.shouldReconnect = true;
    
    if (this.apiKey) {
        this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    } else {
        this.onStatusChange(ConnectionStatus.ERROR);
        return;
    }

    this.onStatusChange(ConnectionStatus.CONNECTING);

    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
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
            systemInstruction: `Ты VisionOS (Вижн ОС). Тактический ИИ костюма. 
            
            ИНСТРУМЕНТЫ (ВЫЗЫВАЙ ЧЕРЕЗ XML):
            1. Управление камерой (Zoom):
               <call:camera_zoom {"level": 1.0} /> (Норма)
               <call:camera_zoom {"level": 2.0} /> (Увеличение x2)
               <call:camera_zoom {"level": 3.0} /> (Максимум x3)
            
            2. Фильтрация целей (Сегментация):
               <call:set_filter {"type": "all"} /> (Показать всё)
               <call:set_filter {"type": "person"} /> (Только люди/живая сила)
               <call:set_filter {"type": "vehicle"} /> (Только техника)

            ИНСТРУКЦИЯ:
            1. Язык общения: ТОЛЬКО РУССКИЙ.
            2. Отвечай мгновенно. Не жди длинных пауз.
            3. Стиль: Военный, четкий, механический. Без лирики.
            4. СРАЗУ ПОСЛЕ ПОДКЛЮЧЕНИЯ скажи: "VisionOS онлайн. Жду команд."
            5. Если оператор просит "увеличить", "зум", "ближе" - используй camera_zoom.
            6. Если оператор просит "показать людей", "выделить цели", "убрать мусор" - используй set_filter.`,
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
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;

    console.log(`Reconnecting in ${Math.round(delay)}ms...`);

    setTimeout(() => {
        this.reconnectAttempts++;
        this.connect();
    }, delay);
  }

  private async handleMessage(message: LiveServerMessage) {
    // 1. Handle Interruption
    if (message.serverContent?.interrupted) {
        console.log("VisionOS: Interrupted by operator");
        this.stopAllAudio();
        return;
    }

    // 2. Audio Output
    const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
    if (audioData && this.audioContext) {
      this.scheduleAudioChunk(audioData);
    }

    // 3. Text & Tools
    const parts = message.serverContent?.modelTurn?.parts;
    if (parts) {
        parts.forEach((part: any) => {
            if (part.text) {
                this.parseHeuristicToolCalls(part.text);
                const cleanText = part.text.replace(TOOL_CALL_REGEX, '').trim();
                if (cleanText) this.onTranscript(cleanText, true); 
            }
        });
    }
  }

  private stopAllAudio() {
      // Invalidate any audio currently decoding
      this.currentTurnVersion++;

      this.activeSources.forEach(source => {
          try { source.stop(); } catch(e) {}
      });
      this.activeSources = [];
      
      if (this.audioContext) {
          this.nextStartTime = this.audioContext.currentTime;
      }
  }

  private async scheduleAudioChunk(base64Data: string) {
    // Capture version before async op
    const localVersion = this.currentTurnVersion;
    
    if (!this.audioContext) return;
    try {
        const audioBytes = base64ToUint8Array(base64Data);
        const buffer = await decodeAudioData(audioBytes, this.audioContext, 24000);
        
        // Check if interrupted during decode
        if (localVersion !== this.currentTurnVersion) {
            return;
        }

        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(this.audioContext.destination);
        
        const currentTime = this.audioContext.currentTime;
        
        // Strict timing to avoid overlap
        if (this.nextStartTime < currentTime) {
            this.nextStartTime = currentTime + 0.02; // Minimal buffer
        } 
        // If drift is too large, snap back, but don't cut off unless huge
        else if (this.nextStartTime > currentTime + 0.5) {
             // If we are way ahead, it's fine, it just means we have a buffer.
        }
        
        source.start(this.nextStartTime);
        this.nextStartTime += buffer.duration;

        this.activeSources.push(source);
        source.onended = () => {
            this.activeSources = this.activeSources.filter(s => s !== source);
        };

    } catch (e) {
        // Ignore decode errors
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
            } else if (payload.markers) {
                // Legacy support for direct marker injection (if needed)
                const aiMarkers = payload.markers.map((m: any) => ({ ...m, source: 'ai' }));
                this.onMarkerUpdate(aiMarkers, payload.action || 'add');
            }
        } catch (e) { /* Safe fail */ }
    }
  }

  private async startAudioInput() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
      }});
      
      if (!this.audioContext) return;

      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 128;
      this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);

      const blob = new Blob([AUDIO_WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      await this.audioContext.audioWorklet.addModule(workletUrl);

      this.inputWorklet = new AudioWorkletNode(this.audioContext, 'mic-processor');
      this.inputWorklet.port.onmessage = (event) => {
        const inputData = event.data as Float32Array;
        
        // 1. Calculate RMS Level
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
        const rms = Math.sqrt(sum / inputData.length);
        
        this.onAudioLevel(rms * 50); 

        // 2. Buffer & Send
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

      // VAD
      if (rms < this.NOISE_THRESHOLD) {
          this.silenceCounter++;
          if (this.silenceCounter > 10) return; 
      } else {
          this.silenceCounter = 0;
      }

      const resampled = downsampleBuffer(chunk, this.audioContext.sampleRate, 16000);
      
      const newBuffer = new Float32Array(this.inputBuffer.length + resampled.length);
      newBuffer.set(this.inputBuffer);
      newBuffer.set(resampled, this.inputBuffer.length);
      this.inputBuffer = newBuffer;

      // Send smaller chunks for faster server-side VAD
      if (this.inputBuffer.length >= this.CHUNK_SIZE) {
          const chunkToSend = this.inputBuffer.slice(0, this.CHUNK_SIZE);
          this.inputBuffer = this.inputBuffer.slice(this.CHUNK_SIZE);
          
          if (this.session) {
              const pcmInt16 = float32ToInt16(chunkToSend);
              const base64 = arrayBufferToBase64(pcmInt16.buffer);
              try {
                  this.session.sendRealtimeInput({ 
                      media: { mimeType: "audio/pcm;rate=16000", data: base64 } 
                  });
              } catch (e) {
                  console.warn("Gemini: Failed to send audio input");
              }
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
        try {
            this.session.sendRealtimeInput({
                media: { mimeType: 'image/jpeg', data: base64Image }
            });
        } catch (e) {
            console.warn("Gemini: Failed to send video frame");
        }
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
    this.onStatusChange(ConnectionStatus.DISCONNECTED);
  }
}
