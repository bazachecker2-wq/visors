
import React, { useEffect, useRef, useState, useCallback } from 'react';
import VideoHUD from './components/VideoHUD';
import ChatEnvelope from './components/ChatEnvelope';
import UserList from './components/UserList';
import { GeminiService } from './services/geminiService';
import { P2PService } from './services/p2pService';
import { BackendService } from './services/pocketbaseService';
import { ConnectionStatus, Marker, Player, ChatMessage, CameraCommand } from './types';

const generateId = () => Math.random().toString(36).substring(2, 6).toUpperCase();

const App: React.FC = () => {
  // --- State ---
  // Active Configuration
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('GEMINI_API_KEY') || process.env.API_KEY || '');
  const [pbUrl, setPbUrl] = useState<string>(() => localStorage.getItem('PB_URL') || 'http://64.188.125.22:8090');
  
  // Settings Form State (Decoupled to prevent re-init on type)
  const [formApiKey, setFormApiKey] = useState(apiKey);
  const [formPbUrl, setFormPbUrl] = useState(pbUrl);

  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [transcript, setTranscript] = useState('');
  
  // Situation Text
  const [sysMessage, setSysMessage] = useState<{text: string, ts: number} | null>(null);
  
  // Camera State
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [activeFilter, setActiveFilter] = useState<string>('all');

  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [showSettings, setShowSettings] = useState(!apiKey);
  
  // Multiplayer State
  const [myId] = useState(generateId());
  const [myPeerId, setMyPeerId] = useState<string>('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeChatTarget, setActiveChatTarget] = useState<string | null>(null);
  const [backendConnected, setBackendConnected] = useState(false);
  
  // --- Refs & Services ---
  const geminiRef = useRef<GeminiService | null>(null);
  const p2pRef = useRef<P2PService | null>(null);
  const backendRef = useRef<BackendService | null>(null);
  const audioCanvasRef = useRef<HTMLCanvasElement>(null);

  // --- Initialization ---
  useEffect(() => {
    // 1. Init Backend
    backendRef.current = new BackendService(pbUrl);
    
    // Check for Mixed Content issues immediately
    if (window.location.protocol === 'https:' && pbUrl.startsWith('http:')) {
        console.warn("PocketBase Warning: Mixed Content (Connecting to HTTP from HTTPS).");
        setSysMessage({ text: "ОШИБКА: HTTP/HTTPS КОНФЛИКТ", ts: Date.now() });
        setBackendConnected(false);
    }

    backendRef.current.init().then(async (isConnected) => {
        if (isConnected) {
            setBackendConnected(true);
            setSysMessage(null); // Clear mixed content error if somehow connected
            
            // 2. Join Game
            await backendRef.current?.joinGame({
                id: myId,
                name: `ОПЕРАТОР-${myId}`,
                peerId: '', // Will update later
                lastSeen: Date.now(),
                audioEnabled: true,
                markersCount: 0
            });

            // 3. Subscribe to Data
            backendRef.current?.subscribeToPlayers((serverPlayers) => {
                // Filter out stale players (inactive > 30s) locally
                const now = Date.now();
                const active = serverPlayers.filter(p => now - p.lastSeen < 30000);
                setPlayers(active);
            });

            backendRef.current?.subscribeToChat((msg) => {
                setMessages(prev => {
                    // Deduplicate based on ID just in case
                    if (prev.some(m => m.id === msg.id)) return prev;
                    return [...prev, msg];
                });
            });
        } else {
            setBackendConnected(false);
        }
    });

    // 4. Init P2P
    p2pRef.current = new P2PService();
    p2pRef.current.init(`OP-${myId}`);
    
    p2pRef.current.onPeerOpen = (id) => {
        setMyPeerId(id);
        // Sync PeerID to Backend
        backendRef.current?.updatePresence({ peerId: id });
    };

    p2pRef.current.onIncomingCall = (call) => {
        if (localStream) {
            call.answer(localStream);
            call.on('stream', (remote) => setRemoteStream(remote));
        }
    };

    // 5. Heartbeat & Cleanup
    const heartbeatInterval = setInterval(() => {
        if (backendConnected) {
             backendRef.current?.updatePresence({ markersCount: markers.length });
        }
    }, 4000);

    const cleanup = () => {
        backendRef.current?.leaveGame();
        if (geminiRef.current) geminiRef.current.disconnect();
        if (p2pRef.current) p2pRef.current.destroy();
    };

    window.addEventListener('beforeunload', cleanup);

    return () => {
        clearInterval(heartbeatInterval);
        window.removeEventListener('beforeunload', cleanup);
        cleanup();
    };
  }, [myId, pbUrl]); // Intentionally exclude backendConnected to avoid loop

  // --- Camera Logic ---
  useEffect(() => {
    let isMounted = true;
    const initCamera = async () => {
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        await new Promise(r => setTimeout(r, 200));
        if (!isMounted) return;

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { facingMode: facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }, 
                audio: { echoCancellation: true, noiseSuppression: true } 
            });
            if (isMounted) {
                setLocalStream(stream);
                setZoomLevel(1); // Reset zoom on camera switch
            }
        } catch (e) {
            try {
                if (!isMounted) return;
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                if (isMounted) setLocalStream(stream);
            } catch (fatalError) {
                console.error("Camera permission denied", fatalError);
            }
        }
    };
    initCamera();
    return () => { isMounted = false; };
  }, [facingMode]);

  const toggleCamera = () => setFacingMode(prev => prev === 'environment' ? 'user' : 'environment');

  const applyCameraZoom = async (level: number) => {
      if (!localStream) return;
      const track = localStream.getVideoTracks()[0];
      const capabilities = track.getCapabilities() as any;
      
      // Attempt Hardware Zoom
      if (capabilities && capabilities.zoom) {
          try {
             const zoomValue = Math.min(Math.max(level, capabilities.zoom.min), capabilities.zoom.max);
             await track.applyConstraints({ advanced: [{ zoom: zoomValue }] as any });
             // If hardware zoom works, we don't need digital zoom
             setZoomLevel(1); 
             return;
          } catch(e) {
              console.warn("Hardware zoom failed, falling back to digital");
          }
      }
      
      // Fallback to Digital Zoom (State used by VideoHUD)
      setZoomLevel(level);
  };

  const handleCameraCommand = (cmd: CameraCommand) => {
      if (cmd.type === 'zoom') {
          const val = Number(cmd.value);
          if (!isNaN(val)) applyCameraZoom(val);
      } else if (cmd.type === 'filter') {
          const filter = String(cmd.value).toLowerCase();
          setActiveFilter(filter);
          setSysMessage({ text: `ФИЛЬТР: ${filter === 'all' ? 'ОТКЛ' : filter.toUpperCase()}`, ts: Date.now() });
          setTimeout(() => setSysMessage(null), 3000);
      }
  };

  // --- Audio Viz Loop ---
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
            const barWidth = 3;
            const gap = 1;
            const bufferLength = spectrum.length;
            const totalBars = Math.floor(canvas.width / (barWidth + gap));
            const cx = canvas.width / 2;
            ctx.fillStyle = '#ffaa00';
            ctx.shadowBlur = 4;
            ctx.shadowColor = '#ffaa00';

            for (let i = 0; i < totalBars / 2; i++) {
                const index = Math.floor((i / (totalBars / 2)) * (bufferLength / 2));
                const value = spectrum[index] || 0;
                const percent = value / 255;
                const height = percent * canvas.height;
                ctx.fillStyle = percent > 0.8 ? '#ff3300' : (percent > 0.5 ? '#ffaa00' : '#aa6600');
                ctx.fillRect(cx + i * (barWidth + gap), (canvas.height - height) / 2, barWidth, height);
                ctx.fillRect(cx - (i + 1) * (barWidth + gap), (canvas.height - height) / 2, barWidth, height);
            }
            ctx.shadowBlur = 0;
        } else {
             ctx.strokeStyle = '#331100';
             ctx.lineWidth = 1;
             ctx.beginPath();
             ctx.moveTo(0, canvas.height / 2);
             ctx.lineTo(canvas.width, canvas.height / 2);
             ctx.stroke();
        }
        animationFrameId = requestAnimationFrame(renderAudioViz);
    };
    renderAudioViz();
    return () => cancelAnimationFrame(animationFrameId);
  }, []);

  // --- Gemini Logic ---
  const toggleGemini = useCallback(async () => {
    if (status === ConnectionStatus.CONNECTED) {
        geminiRef.current?.disconnect();
        return;
    }
    if (!apiKey) {
        setShowSettings(true);
        return;
    }
    if (!geminiRef.current) {
        geminiRef.current = new GeminiService(apiKey);
        geminiRef.current.onStatusChange = (s) => setStatus(s);
        geminiRef.current.onCameraCommand = handleCameraCommand;
        geminiRef.current.onTranscript = (text, isFinal) => {
            setTranscript(text);
            if (isFinal) {
                if (backendRef.current) backendRef.current.addMemory(text, 'ai', myId);
                setSysMessage({ text: text.toUpperCase(), ts: Date.now() });
                setTimeout(() => setSysMessage(prev => (prev && Date.now() - prev.ts >= 5000) ? null : prev), 6000);
            }
        };
        geminiRef.current.onMarkerUpdate = (newMarkers, action) => {
            setMarkers(prev => {
                if (action === 'add') return [...prev, ...newMarkers];
                if (action === 'clear') return [];
                return newMarkers;
            });
        };
    } else {
        geminiRef.current.updateApiKey(apiKey);
    }
    await geminiRef.current.connect();
  }, [apiKey, status, myId]);

  const handleSendMessage = (text: string, targetId?: string) => {
    const msg: ChatMessage = {
        id: generateId(),
        senderId: myId,
        senderName: `ОП-${myId}`,
        text,
        timestamp: Date.now(),
        ...(targetId ? { targetId } : {})
    };
    
    backendRef.current?.sendMessage(msg);
    backendRef.current?.addMemory(text, 'user', myId);
  };

  const handleCallUser = (peerId: string) => {
      if (!localStream || !p2pRef.current) return;
      const call = p2pRef.current.callUser(peerId, localStream);
      if (call) {
          call.on('stream', (remote) => setRemoteStream(remote));
          call.on('error', (err) => console.error(err));
      }
  };

  const saveSettings = (e: React.FormEvent) => {
      e.preventDefault();
      // Commit changes
      setApiKey(formApiKey);
      setPbUrl(formPbUrl);

      localStorage.setItem('GEMINI_API_KEY', formApiKey);
      localStorage.setItem('PB_URL', formPbUrl);
      
      // Note: Changing pbUrl triggers useEffect because it's a dependency,
      // so we don't need to manually re-init here. 
      // The state update will fire the effect.
      setShowSettings(false);
  };

  return (
    <div className="relative w-screen h-[100dvh] bg-black overflow-hidden text-orange-500 selection:bg-orange-500 selection:text-black touch-none">
      
      {/* Layer 0: Video & HUD Canvas */}
      <VideoHUD 
        markers={markers} 
        localStream={localStream}
        onVideoFrame={(base64) => geminiRef.current?.sendVideoFrame(base64)}
        zoomLevel={zoomLevel}
        activeFilter={activeFilter}
      />

      {/* Layer 1: Remote Video (PiP) */}
      {remoteStream && (
          <div className="absolute top-24 right-4 w-40 h-28 md:w-64 md:h-48 border-2 border-white z-30 shadow-lg shadow-orange-900/50">
              <video ref={ref => { if(ref) ref.srcObject = remoteStream }} autoPlay className="w-full h-full object-cover grayscale sepia" />
              <div className="absolute top-0 left-0 bg-red-600 text-white px-1 text-[8px] md:text-[10px] font-bold animate-pulse">REC</div>
              <button onClick={() => setRemoteStream(null)} className="absolute top-0 right-0 bg-black text-white px-2 text-[10px] hover:bg-red-600">X</button>
          </div>
      )}

      {/* Layer 2: UI Overlay */}
      <div className="absolute top-0 left-0 w-full p-2 md:p-4 flex justify-between items-start pointer-events-none z-20 pt-safe-top">
        <div className="flex flex-col items-start pointer-events-auto">
            <h1 className="text-lg md:text-2xl leading-none font-bold text-orange-500 pixel-text-shadow mb-1 md:mb-2">
                VISION<span className="text-white">OS</span>
            </h1>
            <div className="text-[8px] md:text-[10px] font-bold text-orange-700 pixel-text-shadow flex flex-col gap-1">
                 <span>ID: {myPeerId ? myPeerId.split('-').pop() : '...'}</span>
                 <span>AI: <span className={status === ConnectionStatus.CONNECTED ? 'text-white' : 'text-red-500'}>{status}</span></span>
                 <span>DB: <span className={backendConnected ? 'text-green-500' : 'text-red-500'}>{backendConnected ? 'SYNC' : 'OFFLINE'}</span></span>
                 <span>ZOOM: <span className="text-white">{zoomLevel.toFixed(1)}x</span></span>
            </div>
            
            <div className="mt-2 opacity-90 border border-orange-900/50 bg-black/40 p-1">
                <canvas ref={audioCanvasRef} width={150} height={30} className="block md:w-[200px] md:h-[40px]" />
            </div>
        </div>

        <div className="flex flex-col items-end gap-2 pointer-events-auto">
            <div className="flex gap-4">
                <button onClick={toggleCamera} className="text-xl md:text-2xl text-orange-500 hover:text-white pixel-text-shadow p-2 active:scale-95 transition" title="Сменить камеру">
                    <i className="fas fa-camera-rotate"></i>
                </button>
                <button onClick={toggleGemini} className={`text-xl md:text-2xl font-bold pixel-text-shadow hover:scale-110 active:scale-95 transition-transform p-2 ${status === ConnectionStatus.CONNECTED ? 'text-white animate-pulse' : 'text-orange-500'}`}>
                    <i className={`fas ${status === ConnectionStatus.CONNECTED ? 'fa-stop-circle' : 'fa-play-circle'}`}></i>
                </button>
                <button onClick={() => setShowSettings(true)} className="text-xl md:text-2xl text-orange-500 hover:text-white pixel-text-shadow p-2 active:scale-95 transition">
                    <i className="fas fa-cog"></i>
                </button>
            </div>

            {sysMessage && (
                <div className="mt-4 max-w-[200px] md:max-w-xs text-right animate-fade-in-out">
                    <div className="text-[8px] text-orange-700 font-bold mb-1">>> АНАЛИЗ ОБСТАНОВКИ</div>
                    <div className="text-xs md:text-sm font-bold text-white leading-tight pixel-text-shadow bg-black/60 p-2 border-r-2 border-orange-500">
                        {sysMessage.text}
                    </div>
                </div>
            )}
        </div>
      </div>

      <div className="absolute bottom-28 md:bottom-24 left-1/2 -translate-x-1/2 w-11/12 max-w-3xl pointer-events-none z-10 text-center">
          {transcript && (
              <span className="text-xs md:text-sm font-bold text-orange-100 pixel-text-shadow leading-snug tracking-wide bg-black/50 px-3 py-1 backdrop-blur-sm rounded-sm">
                  {transcript}
              </span>
          )}
      </div>

      <div className="pointer-events-auto z-20">
        <UserList players={players} currentPlayerId={myId} onCallUser={handleCallUser} onChatUser={(pid) => setActiveChatTarget(pid)} />
      </div>

      <div className="pointer-events-auto z-20">
        <ChatEnvelope players={players} messages={messages} currentPlayerId={myId} onSendMessage={handleSendMessage} activeTargetId={activeChatTarget} />
      </div>

      {showSettings && (
          <div className="absolute inset-0 bg-black/95 flex items-center justify-center z-50 p-4">
              <form onSubmit={saveSettings} className="w-full max-w-md text-center p-6 flex flex-col gap-6 border border-orange-900/50 bg-black/50 backdrop-blur-md">
                  <h2 className="text-xl text-white mb-2 pixel-text-shadow">НАСТРОЙКИ ЯДРА</h2>
                  
                  <div>
                      <label className="block text-xs text-orange-700 mb-1">GEMINI API KEY</label>
                      <input 
                        type="password" 
                        value={formApiKey}
                        onChange={e => setFormApiKey(e.target.value)}
                        className="w-full bg-transparent border-b-2 border-orange-500 text-center text-orange-500 text-sm outline-none placeholder-orange-900 py-2"
                        placeholder="API KEY"
                      />
                  </div>

                  <div>
                      <label className="block text-xs text-orange-700 mb-1">POCKETBASE URL</label>
                      <input 
                        type="text" 
                        value={formPbUrl}
                        onChange={e => setFormPbUrl(e.target.value)}
                        className="w-full bg-transparent border-b-2 border-orange-500 text-center text-orange-500 text-sm outline-none placeholder-orange-900 py-2"
                        placeholder="URL"
                      />
                  </div>

                  <div className="flex justify-center gap-8 text-sm mt-4">
                      <button type="button" onClick={() => setShowSettings(false)} className="text-gray-500 hover:text-white py-2 px-4">[ ОТМЕНА ]</button>
                      <button type="submit" className="text-orange-500 hover:text-white font-bold animate-pulse py-2 px-4">[ ПРИНЯТЬ ]</button>
                  </div>
              </form>
          </div>
      )}
      
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
        .pt-safe-top {
            padding-top: max(1rem, env(safe-area-inset-top));
        }
      `}</style>
    </div>
  );
};

export default App;
