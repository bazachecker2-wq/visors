
import React, { useEffect, useRef, useState, useCallback } from 'react';
import VideoHUD from './components/VideoHUD';
import { GeminiService } from './services/geminiService';
import { ConnectionStatus, Marker, CameraCommand } from './types';

interface TranscriptItem {
    id: string;
    text: string;
    source: 'user' | 'ai';
    isFinal: boolean;
}

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [visualMode, setVisualMode] = useState<'normal' | 'night' | 'thermal' | 'machine' | 'wireframe'>('normal');
  const [xrEnabled, setXrEnabled] = useState(false);

  const audioCanvasRef = useRef<HTMLCanvasElement>(null);
  const geminiRef = useRef<GeminiService | null>(null);

  useEffect(() => {
    if (!geminiRef.current) {
        geminiRef.current = new GeminiService();
        setTimeout(() => toggleGemini(), 500);
    }
    return () => geminiRef.current?.disconnect();
  }, []);

  useEffect(() => {
    let isMounted = true;
    const initCamera = async () => {
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } }, 
                audio: false 
            });
            if (isMounted) setLocalStream(stream);
        } catch (e) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true });
                if (isMounted) setLocalStream(stream);
            } catch (err) { console.error('Camera failed:', err); }
        }
    };
    initCamera();
    return () => { isMounted = false; };
  }, [facingMode]);

  const handleCameraCommand = useCallback((cmd: CameraCommand) => {
      switch (cmd.type) {
          case 'zoom':
              setZoomLevel(Math.min(5, Math.max(1, Number(cmd.value))));
              break;
          case 'filter':
              const validModes = ['normal', 'night', 'thermal', 'machine', 'wireframe'];
              if (validModes.includes(cmd.value)) setVisualMode(cmd.value as any);
              break;
          case 'marker_add':
              const { label, x, y, w, h, color } = cmd.value;
              const newId = 'ai-' + Math.random().toString(36).substr(2, 9);
              setMarkers(prev => [...prev, {
                  id: newId, label, x, y, width: w, height: h, color, source: 'ai', lastUpdated: Date.now()
              }]);
              break;
          case 'marker_mod':
              const mod = cmd.value;
              setMarkers(prev => prev.map(m => m.id === mod.id ? { ...m, label: mod.label || m.label, activity: mod.activity || m.activity, color: mod.color || m.color } : m));
              break;
          case 'marker_rem':
              setMarkers(prev => prev.filter(m => m.id !== cmd.value));
              break;
          case 'activity':
              const { id, text } = cmd.value;
              setMarkers(prev => prev.map(m => m.id === id ? { ...m, activity: text } : m));
              break;
      }
  }, []);

  const onVideoFrame = useCallback((base64: string) => {
    if (status === ConnectionStatus.CONNECTED) {
        geminiRef.current?.sendVideoFrame(base64);
    }
  }, [status]);

  const toggleGemini = useCallback(async () => {
    if (status === ConnectionStatus.CONNECTED) { 
        geminiRef.current?.disconnect(); 
        return; 
    }
    if (geminiRef.current) {
        geminiRef.current.onStatusChange = setStatus;
        geminiRef.current.onCameraCommand = handleCameraCommand;
        geminiRef.current.onTranscript = (text, source, isFinal) => {
            setTranscripts(prev => {
                const existingIdx = prev.findIndex(t => t.source === source && !t.isFinal);
                if (existingIdx !== -1) {
                    const next = [...prev];
                    next[existingIdx] = { ...next[existingIdx], text, isFinal };
                    if (isFinal) {
                        const idToKill = next[existingIdx].id;
                        setTimeout(() => setTranscripts(curr => curr.filter(t => t.id !== idToKill)), 5000);
                    }
                    return next;
                }
                const id = Math.random().toString(36).substr(2, 9);
                if (isFinal) setTimeout(() => setTranscripts(curr => curr.filter(t => t.id !== id)), 5000);
                return [...prev, { id, text, source, isFinal }];
            });
        };
        try { 
          await geminiRef.current.connect(); 
        } catch (err) { 
          setStatus(ConnectionStatus.ERROR); 
        }
    }
  }, [status, handleCameraCommand]);

  const handleKeySelect = useCallback(() => {
    geminiRef.current?.openKeyDialog();
  }, []);

  const handleAddManualMarker = useCallback((x: number, y: number) => {
      const id = 'manual-' + Math.random().toString(36).substr(2, 9);
      const newMarker: Marker = {
          id, x, y, label: 'ЦЕЛЬ', source: 'manual', lastUpdated: Date.now()
      };
      setMarkers(prev => [...prev, newMarker]);
      setTimeout(() => setMarkers(prev => prev.filter(m => m.id !== id)), 40000);
  }, []);

  useEffect(() => {
    let frameId: number;
    const renderVis = () => {
        const spec = geminiRef.current?.getAudioSpectrum();
        if (audioCanvasRef.current) {
            const ctx = audioCanvasRef.current.getContext('2d');
            if (ctx) {
                const w = audioCanvasRef.current.width, h = audioCanvasRef.current.height;
                ctx.clearRect(0, 0, w, h);
                const barCount = 20;
                const barW = w / barCount;
                ctx.fillStyle = visualMode === 'machine' ? '#00ff41' : '#ffaa00';
                for(let i=0; i<barCount; i++) {
                    const val = spec ? spec[i * 2] : Math.random() * 10; 
                    const barH = (val / 255) * h;
                    ctx.fillRect(i * barW, h - barH, barW - 1, barH);
                }
            }
        }
        frameId = requestAnimationFrame(renderVis);
    };
    renderVis();
    return () => cancelAnimationFrame(frameId);
  }, [visualMode, status]);

  return (
    <div className={`relative w-screen h-[100dvh] bg-black overflow-hidden font-mono text-[10px] ${xrEnabled ? 'xr-stereo' : ''}`}>
      <VideoHUD 
        markers={markers} 
        localStream={localStream} 
        zoomLevel={zoomLevel} 
        visualMode={visualMode} 
        onVideoFrame={onVideoFrame}
        onAddManualMarker={handleAddManualMarker}
        xrMode={xrEnabled}
      />
      
      <div className={`absolute inset-0 pointer-events-none z-30 flex ${xrEnabled ? 'flex-row' : ''}`}>
          {[0, ...(xrEnabled ? [1] : [])].map((viewIdx) => (
            <div key={viewIdx} className={`relative h-full flex-grow flex flex-col p-4 pt-safe ${xrEnabled ? 'border-r border-white/10' : ''}`}>
                <div className="flex justify-between items-start pointer-events-none">
                    <div className="flex flex-col gap-1 pointer-events-auto">
                        <h1 className={`text-xl font-black ${visualMode === 'machine' ? 'text-green-500' : 'text-orange-500'} pixel-text-shadow tracking-tighter`}>
                            ВИЖН<span className="text-white">ОС</span><span className="text-[7px] ml-1 opacity-40">2.5_PRO</span>
                        </h1>
                        <div className={`text-[7px] px-2 py-0.5 inline-block uppercase tracking-widest border-l-2 ${
                            status === ConnectionStatus.CONNECTED ? 'bg-green-900/40 text-green-400 border-green-500' :
                            status === ConnectionStatus.CONNECTING ? 'bg-blue-900/40 text-blue-400 border-blue-500' :
                            'bg-black/40 text-white/60 border-orange-500'
                        }`}>
                            СТАТУС: {status} | РЕЖИМ: {visualMode} | ЗУМ: {zoomLevel.toFixed(1)}x
                        </div>
                        
                        <div className="mt-2 bg-black/50 p-1 border border-orange-500/10 backdrop-blur-sm">
                            <canvas ref={viewIdx === 0 ? audioCanvasRef : undefined} width={120} height={25} className="opacity-80" />
                        </div>
                    </div>
                    
                    {viewIdx === 0 && (
                        <div className="flex gap-2 pointer-events-auto items-center">
                            <button onClick={() => setXrEnabled(!xrEnabled)} className={`p-2 border transition-all ${xrEnabled ? 'bg-orange-500 text-black border-orange-500' : 'bg-black/40 border-orange-500/20 text-orange-500'}`}>
                                <i className="fas fa-vr-cardboard" />
                            </button>
                            <button onClick={handleKeySelect} className="p-2 text-white bg-blue-900/40 border border-blue-500/20">
                                <i className="fas fa-key text-[9px]" />
                            </button>
                            <button onClick={toggleGemini} className={`p-2 border transition-all ${status === ConnectionStatus.CONNECTED ? 'bg-red-900/80 border-red-500' : 'bg-black/40 border-orange-500/20'}`}>
                                <i className={`fas ${status === ConnectionStatus.CONNECTED ? 'fa-stop' : 'fa-microphone'}`} />
                            </button>
                        </div>
                    )}
                </div>

                <div className="mt-auto mb-10 flex flex-col items-center w-full max-w-lg mx-auto">
                    {transcripts.map(t => (
                        <div key={t.id} className={`mb-2 px-4 py-2 bg-black/80 border-l-4 ${t.source === 'ai' ? 'border-orange-500' : 'border-blue-500'} shadow-lg`}>
                            <div className="text-white uppercase pixel-text-shadow leading-tight text-[10px] tracking-tight">
                                <span className="text-[7px] opacity-50 block mb-1">{t.source === 'ai' ? 'ОПЕРАТОР' : 'ВЫ'}:</span>
                                {t.text}{!t.isFinal && <span className="animate-pulse">_</span>}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
          ))}
      </div>

      <style>{`
        .pt-safe { padding-top: max(1rem, env(safe-area-inset-top)); }
        .pixel-text-shadow { text-shadow: 1px 1px 0px #000; }
        .xr-stereo { cursor: none; }
        @keyframes scan { from { transform: translateY(-100%); } to { transform: translateY(100vh); } }
        .scanline { position: absolute; width: 100%; height: 2px; background: rgba(255,170,0,0.1); animation: scan 3s linear infinite; pointer-events: none; z-index: 60; }
      `}</style>
    </div>
  );
};

export default App;
