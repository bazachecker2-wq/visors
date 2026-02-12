
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";
import { AUDIO_WORKLET_CODE, float32ToInt16, base64ToUint8Array, decodeAudioData, downsampleBuffer, arrayBufferToBase64 } from "../utils/audioUtils";
import { ConnectionStatus, CameraCommand } from "../types";

export class GeminiService {
  private sessionPromise: Promise<any> | null = null;
  private inputAudioContext: AudioContext | null = null;
  private outputAudioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStartTime: number = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private micStream: MediaStream | null = null;
  private micNode: AudioWorkletNode | null = null;
  
  private retryCount = 0;
  private maxRetries = 8;
  private isConnecting = false;
  private isClosed = false;
  private retryTimeout: any = null;

  public onStatusChange: (status: ConnectionStatus) => void = () => {};
  public onTranscript: (text: string, source: 'user' | 'ai', isFinal: boolean) => void = () => {};
  public onCameraCommand: (cmd: CameraCommand) => void = () => {};

  private async ensureApiKey() {
    // @ts-ignore
    if (window.aistudio && typeof window.aistudio.hasSelectedApiKey === 'function') {
      // @ts-ignore
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        // @ts-ignore
        await window.aistudio.openSelectKey();
      }
    }
  }

  public async connect() {
    if (this.isConnecting) return;
    this.isClosed = false;
    this.retryCount = 0;
    
    if (!this.inputAudioContext) {
      this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
    }
    if (!this.outputAudioContext) {
      this.outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }

    await this.initSession();
  }

  private async initSession() {
    if (this.isClosed) return;
    this.isConnecting = true;
    this.onStatusChange(ConnectionStatus.CONNECTING);
    
    try {
      await this.ensureApiKey();
      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("API Key not found");
      }

      // Using gemini-2.0-flash-exp as it is known to be the most stable for Live API 
      // and often avoids backend tokenizer inference errors reported by users.
      const ai = new GoogleGenAI({ apiKey });

      if (this.sessionPromise) {
          try {
            const oldSession = await this.sessionPromise;
            oldSession.close();
          } catch(e) {}
          this.sessionPromise = null;
      }

      this.sessionPromise = ai.live.connect({
        model: 'gemini-2.0-flash-exp',
        callbacks: {
          onopen: () => { 
              console.log("Live API: Connection Successful");
              this.retryCount = 0;
              this.isConnecting = false;
              if (this.isClosed) { this.disconnect(); return; }
              this.onStatusChange(ConnectionStatus.CONNECTED); 
              this.startMic(); 
          },
          onmessage: (m) => this.handleMessage(m),
          onclose: (e) => {
              console.log(`Live API: Connection Closed (Code: ${e.code})`);
              if (!this.isClosed) {
                this.onStatusChange(ConnectionStatus.DISCONNECTED);
                this.stopAudio();
                if (e.code !== 1000 && e.code !== 1005) {
                    this.handleTransientError(`Connection closed: ${e.code}`);
                }
              }
              this.isConnecting = false;
          },
          onerror: (e: any) => {
              this.isConnecting = false;
              const msg = e?.message?.toLowerCase() || "";
              console.warn("Live API Error Details:", msg);

              if (msg.includes('permission') || msg.includes('403') || msg.includes('not found') || msg.includes('unauthorized')) {
                  this.onStatusChange(ConnectionStatus.ERROR);
                  // @ts-ignore
                  if (window.aistudio) window.aistudio.openSelectKey();
                  return;
              }

              const isTransient = 
                  msg.includes('unavailable') || 
                  msg.includes('503') || 
                  msg.includes('deadline') || 
                  msg.includes('expired') || 
                  msg.includes('timeout') ||
                  msg.includes('cancelled') ||
                  msg.includes('inference') ||
                  msg.includes('tokenizer') ||
                  msg.includes('failed to connect');

              if (isTransient && this.retryCount < this.maxRetries && !this.isClosed) {
                  this.handleTransientError(msg);
              } else {
                  console.error("Critical Live API Error:", msg);
                  this.onStatusChange(ConnectionStatus.ERROR);
              }
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: `ТЫ - ИИ-ОПЕРАТОР VisionOS. ТЫ ГОВОРИШЬ ТОЛЬКО НА РУССКОМ.
Работаешь в режиме реального времени. Видишь видеопоток и слышишь голос.

КОМАНДЫ ДЛЯ ВЫПОЛНЕНИЯ:
1. <zoom:X.X> - зум 1.0-5.0.
2. <filter:MODE> - night, thermal, machine.
3. <marker:add:МЕТКА:X:Y:W:H:COLOR> - Добавить метку.
4. <marker:mod:ID:МЕТКА:АКТИВНОСТЬ:COLOR> - Изменить метку.
5. <marker:rem:ID> - Удалить метку.

Сначала делай действие, потом комментируй на русском.`,
          speechConfig: { 
              voiceConfig: { 
                  prebuiltVoiceConfig: { voiceName: 'Kore' } 
              } 
          }
        }
      });
    } catch (err: any) {
      console.error("Session failed to initialize:", err);
      if (this.retryCount < this.maxRetries && !this.isClosed) {
          this.handleTransientError(err.message || "init failed");
      } else {
          this.onStatusChange(ConnectionStatus.ERROR);
      }
      this.isConnecting = false;
    }
  }

  private handleTransientError(msg: string) {
    if (this.isClosed) return;
    this.retryCount++;
    const delay = Math.min(30000, Math.pow(2, this.retryCount) * 1000) + Math.random() * 1000;
    console.log(`Transient error detected: "${msg}". Retrying attempt ${this.retryCount}/${this.maxRetries} in ${Math.round(delay)}ms...`);
    
    if (this.retryTimeout) clearTimeout(this.retryTimeout);
    this.retryTimeout = setTimeout(() => {
        if (!this.isClosed) {
            this.initSession();
        }
    }, delay);
  }

  private async handleMessage(message: LiveServerMessage) {
    if (this.isClosed) return;

    if (message.serverContent?.inputTranscription) {
        const text = message.serverContent.inputTranscription.text.toLowerCase();
        this.onTranscript(text, 'user', false);
        if (['стой', 'хватит', 'стоп', 'замолчи'].some(w => text.includes(w))) {
            this.stopAudio();
        }
    }

    if (message.serverContent?.interrupted) this.stopAudio();

    const audioPart = message.serverContent?.modelTurn?.parts?.find(p => p.inlineData);
    if (audioPart?.inlineData?.data && this.outputAudioContext) {
      try {
          const audioBuffer = await decodeAudioData(base64ToUint8Array(audioPart.inlineData.data), this.outputAudioContext);
          const source = this.outputAudioContext.createBufferSource();
          source.buffer = audioBuffer; 
          source.connect(this.outputAudioContext.destination);
          this.nextStartTime = Math.max(this.nextStartTime, this.outputAudioContext.currentTime);
          source.start(this.nextStartTime);
          this.nextStartTime += audioBuffer.duration;
          this.activeSources.push(source);
          source.onended = () => { this.activeSources = this.activeSources.filter(s => s !== source); };
      } catch (err) {}
    }

    const aiText = message.serverContent?.outputTranscription?.text;
    if (aiText) {
      this.onTranscript(aiText, 'ai', false);
      this.parseCommands(aiText);
    }

    if (message.serverContent?.turnComplete) {
        this.onTranscript('', 'ai', true);
    }
  }

  private parseCommands(text: string) {
    const zoom = text.match(/<zoom:([\d.]+)\/?>/);
    if (zoom) this.onCameraCommand({ type: 'zoom', value: parseFloat(zoom[1]) });
    const filter = text.match(/<filter:(\w+)\/?>/);
    if (filter) this.onCameraCommand({ type: 'filter', value: filter[1] });
    const addMatches = text.matchAll(/<marker:add:([^:]+):([^:]+):([^:]+):([^:]+):([^:]+):([^>]+)>/g);
    for (const m of addMatches) {
        this.onCameraCommand({ 
            type: 'marker_add', 
            value: { label: m[1], x: parseFloat(m[2]), y: parseFloat(m[3]), w: parseFloat(m[4]), h: parseFloat(m[5]), color: m[6] } 
        });
    }
    const modMatches = text.matchAll(/<marker:mod:([^:]+):([^:]+):([^:]+):([^>]+)>/g);
    for (const m of modMatches) {
        this.onCameraCommand({ 
            type: 'marker_mod', 
            value: { id: m[1], label: m[2], activity: m[3], color: m[4] } 
        });
    }
    const remMatches = text.matchAll(/<marker:rem:([^>]+)>/g);
    for (const m of remMatches) {
        this.onCameraCommand({ type: 'marker_rem', value: m[1] });
    }
  }

  private async startMic() {
    if (this.micStream || this.isClosed) return;
    try {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const sourceNode = this.inputAudioContext!.createMediaStreamSource(this.micStream);
        if (!this.analyser) {
          this.analyser = this.inputAudioContext!.createAnalyser();
          this.analyser.fftSize = 256;
        }
        await this.inputAudioContext!.audioWorklet.addModule(URL.createObjectURL(new Blob([AUDIO_WORKLET_CODE], {type:'application/javascript'})));
        this.micNode = new AudioWorkletNode(this.inputAudioContext!, 'mic-processor');
        this.micNode.port.onmessage = (e) => this.sendAudio(e.data);
        sourceNode.connect(this.analyser); 
        this.analyser.connect(this.micNode);
    } catch(e) { 
      console.error("Mic start failed:", e);
      this.onStatusChange(ConnectionStatus.ERROR);
    }
  }

  private sendAudio(data: Float32Array) {
    if (this.isClosed || !this.sessionPromise) return;
    // Already recorded at 16000, so downsampleBuffer is essentially a pass-through 
    // but kept for robustness if input context sample rate changes.
    const resampled = downsampleBuffer(data, this.inputAudioContext!.sampleRate, 16000);
    const pcm = float32ToInt16(resampled);
    this.sessionPromise.then(s => {
        if (!this.isClosed && s?.sendRealtimeInput) {
            s.sendRealtimeInput({ media: { mimeType: 'audio/pcm;rate=16000', data: arrayBufferToBase64(pcm.buffer) } });
        }
    }).catch(() => {});
  }

  public stopAudio() { 
    this.activeSources.forEach(s => { try { s.stop(); } catch(e) {} }); 
    this.activeSources = []; 
    this.nextStartTime = 0; 
  }
  
  public getAudioSpectrum() {
    if (this.analyser) {
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      return data;
    }
    return null;
  }

  public sendVideoFrame(data: string) { 
      if (this.isClosed || !this.sessionPromise) return;
      this.sessionPromise.then(s => {
          if (!this.isClosed && s?.sendRealtimeInput) {
              s.sendRealtimeInput({ media: { data, mimeType: 'image/jpeg' } });
          }
      }).catch(() => {}); 
  }
  
  public async openKeyDialog() {
    // @ts-ignore
    if (window.aistudio) {
        // @ts-ignore
        await window.aistudio.openSelectKey();
        this.disconnect();
        this.connect();
    }
  }

  public disconnect() { 
      this.isClosed = true;
      if (this.retryTimeout) {
          clearTimeout(this.retryTimeout);
          this.retryTimeout = null;
      }
      if (this.sessionPromise) {
          this.sessionPromise.then(s => {
            try { s.close(); } catch(e) {}
          }).catch(() => {});
          this.sessionPromise = null;
      }
      this.stopAudio(); 
      if (this.micStream) {
        this.micStream.getTracks().forEach(t => t.stop());
        this.micStream = null;
      }
      if (this.micNode) {
        this.micNode.disconnect();
        this.micNode = null;
      }
      this.retryCount = 0;
      this.isConnecting = false;
      this.onStatusChange(ConnectionStatus.DISCONNECTED);
  }
}
