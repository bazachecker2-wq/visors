import React, { useEffect, useRef, useState, useCallback } from 'react';
import VideoHUD from './components/VideoHUD';
import { GeminiService } from './services/geminiService';
import { ConnectionStatus, Marker, CameraCommand } from './types';

interface TranscriptItem {
    id: string;
    text: string;
    source: 'user' | 'ai';
    isFinal: boolean;
    fading?: boolean;
}

const App: React.FC = () => {
  // --- State ---
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [markers, setMarkers] = useState<Marker[]>([]);
  
  // Transcription Log State
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  
  const [sysMessage, setSysMessage] = useState<{text: string, ts: number} | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [visualMode, setVisualMode] = useState<'normal' | 'night' | 'thermal' | 'machine' | 'wireframe'>('normal');

  const audioCanvasRef = useRef<HTMLCanvasElement>(null);
  const geminiRef = useRef<GeminiService | null>(null);
  const zoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Camera Logic ---
  useEffect(() => {
    let isMounted = true;
    const initCamera = async () => {
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        await new Promise(r => setTimeout(r, 200));
        if (!isMounted) return;

        try {
            const constraints: MediaStreamConstraints = { 
                video: { 
                    facingMode: facingMode, 
                    width: { ideal: 1280 }, // Higher res for better distance detection
                    height: { ideal: 720 } 
                }, 
                audio: false 
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            if (isMounted) {
                setLocalStream(stream);
                setZoomLevel(1); 
            }
        } catch (e) {
            console.warn("Camera init failed, retrying simple constraints");
            try {
                if (!isMounted) return;
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                if (isMounted) setLocalStream(stream);
            } catch (err) { console.error(err); }
        }
    };
    initCamera();
    return () => { isMounted = false; };
  }, [facingMode]);

  const toggleCamera = () => setFacingMode(prev => prev === 'environment' ? 'user' : 'environment');

  const toggleVisualMode = () => {
      setVisualMode(prev => {
          if (prev === 'normal') return 'night';
          if (prev === 'night') return 'thermal';
          if (prev === 'thermal') return 'machine';
          if (prev === 'machine') return 'wireframe';
          return 'normal';
      });
  };

  const handleManualZoom = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      setZoomLevel(val);
      // Clear auto-reset timer if user manually intervenes
      if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
  };

  const handleCameraCommand = (cmd: CameraCommand) => {
      if (cmd.type === 'zoom') {
          const val = Number(cmd.value);
          if (!isNaN(val)) {
              setZoomLevel(val);
              
              // AUTO-RESET ZOOM AFTER 3 SECONDS (Only for AI triggers)
              if (zoomTimeoutRef.current) clearTimeout(zoomTimeoutRef.current);
              zoomTimeoutRef.current = setTimeout(() => {
                  setZoomLevel(1);
                  setSysMessage({ text: "ZOOM: RESET", ts: Date.now() });
                  setTimeout(() => setSysMessage(null), 2000);
              }, 3000);
          }
      } else if (cmd.type === 'filter') {
          setActiveFilter(String(cmd.value).toLowerCase());
          setSysMessage({ text: `ФИЛЬТР: ${String(cmd.value).toUpperCase()}`, ts: Date.now() });
          setTimeout(() => setSysMessage(null), 3000);
      }
  };

  // --- Audio Viz ---
  useEffect(() => {
    let animationFrameId: number;
    const renderAudioViz = () => {
        if (!audioCanvasRef.current) {
             animationFrameId = requestAnimationFrame(renderAudioViz);
             return;
        }
        const canvas = audioCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const spectrum = geminiRef.current?.getAudioSpectrum();
        
        if (spectrum) {
            const barWidth = 3; const gap = 1;
            const totalBars = Math.floor(canvas.width / (barWidth + gap));
            const cx = canvas.width / 2;
            ctx.shadowBlur = 4; ctx.shadowColor = visualMode === 'machine' ? '#00ff41' : '#ffaa00';

            for (let i = 0; i < totalBars / 2; i++) {
                const index = Math.floor((i / (totalBars / 2)) * (spectrum.length / 2));
                const value = spectrum[index] || 0;
                const percent = value / 255;
                const height = percent * canvas.height;
                
                if (visualMode === 'machine') {
                    ctx.fillStyle = '#00ff41';
                } else {
                    ctx.fillStyle = percent > 0.8 ? '#ff3300' : (percent > 0.5 ? '#ffaa00' : '#aa6600');
                }
                
                ctx.fillRect(cx + i * (barWidth + gap), (canvas.height - height) / 2, barWidth, height);
                ctx.fillRect(cx - (i + 1) * (barWidth + gap), (canvas.height - height) / 2, barWidth, height);
            }
            ctx.shadowBlur = 0;
        } else {
             ctx.strokeStyle = visualMode === 'machine' ? '#004411' : '#331100'; 
             ctx.lineWidth = 1;
             ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke();
        }
        animationFrameId = requestAnimationFrame(renderAudioViz);
    };
    renderAudioViz();
    return () => cancelAnimationFrame(animationFrameId);
  }, [visualMode]);

  // --- Gemini Logic ---
  const toggleGemini = useCallback(async () => {
    if (status === ConnectionStatus.CONNECTED) {
        geminiRef.current?.disconnect();
        return;
    }

    if (!geminiRef.current) {
        geminiRef.current = new GeminiService();
        geminiRef.current.onStatusChange = (s) => setStatus(s);
        geminiRef.current.onCameraCommand = handleCameraCommand;
        
        geminiRef.current.onTranscript = (text, source, isFinal) => {
            setTranscripts(prev => {
                // USER MESSAGES
                if (source === 'user') {
                     if (!isFinal) {
                        const existingIdx = prev.findIndex(t => t.source === 'user' && !t.isFinal);
                        if (existingIdx !== -1) {
                            const next = [...prev];
                            next[existingIdx] = { ...next[existingIdx], text };
                            return next;
                        }
                        return [...prev, { id: Date.now().toString(), text, source, isFinal: false }];
                     } else {
                        // User message complete
                        const existingIdx = prev.findIndex(t => t.source === 'user' && !t.isFinal);
                        if (existingIdx !== -1) {
                            const next = [...prev];
                            const id = next[existingIdx].id;
                            // Set removal timer - 3 seconds
                            setTimeout(() => {
                                setTranscripts(curr => curr.filter(t => t.id !== id));
                            }, 3000); 
                            next[existingIdx] = { ...next[existingIdx], text, isFinal: true, fading: true };
                            return next;
                        }
                        const id = Date.now().toString();
                        setTimeout(() => {
                            setTranscripts(curr => curr.filter(t => t.id !== id));
                        }, 3000); 
                        return [...prev, { id, text, source, isFinal: true, fading: true }];
                     }
                }

                // AI MESSAGES
                if (source === 'ai') {
                    if (text.includes("угроз") || text.includes("внимание")) {
                        setSysMessage({ text: "ВНИМАНИЕ: ОБНАРУЖЕНА УГРОЗА", ts: Date.now() });
                    }

                    if (!isFinal) {
                        // Update existing streaming AI bubble
                        const existingIdx = prev.findIndex(t => t.source === 'ai' && !t.isFinal);
                        if (existingIdx !== -1) {
                            const next = [...prev];
                            next[existingIdx] = { ...next[existingIdx], text };
                            return next;
                        }
                        return [...prev, { id: Date.now().toString(), text, source, isFinal: false }];
                    } else {
                         // Finalize AI message
                         const existingIdx = prev.findIndex(t => t.source === 'ai' && !t.isFinal);
                         if (existingIdx !== -1) {
                            const next = [...prev];
                            const id = next[existingIdx].id;
                            // 3 seconds timeout
                            setTimeout(() => {
                                setTranscripts(curr => curr.filter(t => t.id !== id));
                            }, 3000);
                            next[existingIdx] = { ...next[existingIdx], text, isFinal: true, fading: true };
                            return next;
                         }
                         // New final message (rare for streaming, but possible)
                         const id = Date.now().toString();
                         setTimeout(() => {
                             setTranscripts(curr => curr.filter(t => t.id !== id));
                         }, 3000);
                         return [...prev, { id, text, source, isFinal: true, fading: true }];
                    }
                }
                
                return prev;
            });
        };

        geminiRef.current.onMarkerUpdate = (newMarkers, action) => {
            setMarkers(prev => action === 'add' ? [...prev, ...newMarkers] : newMarkers);
        };
    }

    await geminiRef.current.connect();
  }, [status]);

  const isMachine = visualMode === 'machine';
  const themeColor = isMachine ? 'text-green-500' : 'text-orange-500';

  return (
    <div className="relative w-screen h-[100dvh] bg-black overflow-hidden selection:bg-orange-500 selection:text-black touch-none">
      
      <VideoHUD 
        markers={markers} 
        localStream={localStream}
        onVideoFrame={(base64) => geminiRef.current?.sendVideoFrame(base64)}
        zoomLevel={zoomLevel}
        activeFilter={activeFilter}
        visualMode={visualMode}
      />

      {/* Top HUD Bar */}
      <div className="absolute top-0 left-0 w-full p-2 md:p-4 flex justify-between items-start pointer-events-none z-20 pt-safe-top">
        <div className="flex flex-col items-start pointer-events-auto">
            <h1 className={`text-lg md:text-2xl leading-none font-bold ${themeColor} pixel-text-shadow mb-1 md:mb-2`}>
                VISION<span className="text-white">OS</span>
            </h1>
            <div className={`text-[8px] md:text-[10px] font-bold ${isMachine ? 'text-green-700' : 'text-orange-700'} pixel-text-shadow flex flex-col gap-1`}>
                 <span>AI: <span className={status === ConnectionStatus.CONNECTED ? 'text-white' : 'text-red-500'}>{status}</span></span>
                 <span>ZOOM: <span className="text-white">{zoomLevel.toFixed(1)}x</span></span>
            </div>
            
            <div className={`mt-2 opacity-90 border ${isMachine ? 'border-green-900/50' : 'border-orange-900/50'} bg-black/40 p-1`}>
                <canvas ref={audioCanvasRef} width={150} height={30} className="block md:w-[200px] md:h-[40px]" />
            </div>
        </div>

        <div className="flex flex-col items-end gap-2 pointer-events-auto">
            <div className="flex gap-4">
                 <button onClick={toggleVisualMode} className={`text-xl md:text-2xl ${themeColor} hover:text-white pixel-text-shadow p-2 active:scale-95 transition`} title="VISUAL MODE">
                    <i className={`fas ${visualMode === 'normal' ? 'fa-eye' : (visualMode === 'night' ? 'fa-moon' : (visualMode === 'thermal' ? 'fa-fire' : (visualMode === 'machine' ? 'fa-robot' : 'fa-vector-square')))}`}></i>
                </button>
                <button onClick={toggleCamera} className={`text-xl md:text-2xl ${themeColor} hover:text-white pixel-text-shadow p-2 active:scale-95 transition`}>
                    <i className="fas fa-camera-rotate"></i>
                </button>
                <button onClick={toggleGemini} className={`text-xl md:text-2xl font-bold pixel-text-shadow hover:scale-110 active:scale-95 transition-transform p-2 ${status === ConnectionStatus.CONNECTED ? 'text-white animate-pulse' : themeColor}`}>
                    <i className={`fas ${status === ConnectionStatus.CONNECTED ? 'fa-stop-circle' : 'fa-play-circle'}`}></i>
                </button>
            </div>

            {sysMessage && (
                <div className="mt-4 max-w-[200px] md:max-w-xs text-right animate-fade-in-out">
                    <div className={`text-[8px] ${isMachine ? 'text-green-700' : 'text-orange-700'} font-bold mb-1`}>&gt;&gt; SYSTEM ALERT</div>
                    <div className={`text-xs md:text-sm font-bold text-white leading-tight pixel-text-shadow bg-black/60 p-2 border-r-2 ${isMachine ? 'border-green-500' : 'border-orange-500'}`}>
                        {sysMessage.text}
                    </div>
                </div>
            )}
        </div>
      </div>

      {/* Manual Zoom Slider */}
      <div className="absolute right-4 top-1/2 -translate-y-1/2 h-48 w-8 z-20 pointer-events-auto flex flex-col items-center gap-2">
         <span className={`text-[10px] font-bold ${themeColor}`}>5x</span>
         <input 
            type="range" 
            min="1" 
            max="5" 
            step="0.1" 
            value={zoomLevel} 
            onChange={handleManualZoom}
            className="w-48 h-2 appearance-none bg-gray-800 border border-gray-600 outline-none opacity-70 hover:opacity-100 transition-opacity -rotate-90 origin-center translate-y-20"
            style={{ accentColor: isMachine ? '#00ff41' : '#ffaa00' }}
         />
         <span className={`text-[10px] font-bold ${themeColor} mt-auto`}>1x</span>
      </div>

      {/* Transcription Area (Disappearing Log) */}
      <div className="absolute bottom-32 left-1/2 -translate-x-1/2 w-full max-w-4xl px-4 flex flex-col gap-2 pointer-events-none z-10 items-center justify-end">
          {transcripts.map((t) => (
             <div 
                key={t.id} 
                className={`flex flex-col items-center animate-fade-in ${t.fading ? 'animate-fade-out-delayed' : ''}`}
             >
                 {t.source === 'ai' && (
                     <div className="text-center">
                          <span className={`text-[10px] ${isMachine ? 'text-green-300' : 'text-orange-300'} font-bold tracking-widest block mb-1`}>AI_CORE</span>
                          <span className={`text-xs md:text-sm font-bold text-white pixel-text-shadow leading-snug bg-black/60 px-3 py-2 border-l-4 ${isMachine ? 'border-green-500' : 'border-orange-500'} backdrop-blur-sm`}>
                              {t.text}
                          </span>
                     </div>
                 )}
                 {t.source === 'user' && (
                      <div className="text-center opacity-90 mt-1">
                          <span className="text-[10px] text-gray-400 font-bold tracking-widest block mb-1">USER_AUDIO</span>
                          <span className="text-xs text-gray-200 pixel-text-shadow bg-black/40 px-2 py-1 italic border-b-2 border-transparent">
                             {t.text}{!t.isFinal && <span className="animate-pulse">_</span>}
                          </span>
                      </div>
                 )}
             </div>
          ))}
      </div>
      
      <style>{`
        @keyframes fadeInOut {
            0% { opacity: 0; transform: translateX(20px); }
            10% { opacity: 1; transform: translateX(0); }
            80% { opacity: 1; }
            100% { opacity: 0; }
        }
        .animate-fade-in-out {
            animation: fadeInOut 5s ease-in-out forwards;
        }
        
        @keyframes fadeOutDelayed {
            0% { opacity: 1; }
            70% { opacity: 1; }
            100% { opacity: 0; }
        }
        .animate-fade-out-delayed {
            animation: fadeOutDelayed 3s ease-out forwards;
        }

        @keyframes slideUp {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in {
            animation: slideUp 0.3s ease-out forwards;
        }
        
        .pt-safe-top {
            padding-top: max(1rem, env(safe-area-inset-top));
        }
        
        /* Custom Range Slider Styling */
        input[type=range]::-webkit-slider-thumb {
            -webkit-appearance: none;
            height: 16px;
            width: 16px;
            background: ${isMachine ? '#00ff41' : '#ffaa00'};
            border: 2px solid white;
            cursor: pointer;
            margin-top: -6px;
            box-shadow: 0 0 5px rgba(0,0,0,0.5);
        }
        input[type=range]::-webkit-slider-runnable-track {
            width: 100%;
            height: 4px;
            cursor: pointer;
            background: rgba(255,255,255,0.2);
            border-radius: 2px;
        }
      `}</style>
    </div>
  );
};

export default App;