
import React, { useEffect, useRef } from 'react';
import { Marker, Keypoint } from '../types';
import { ObjectDetectionService } from '../services/objectDetectionService';

interface VideoHUDProps {
  markers: Marker[]; // AI Markers
  onVideoFrame: (base64: string) => void;
  localStream: MediaStream | null;
  zoomLevel?: number; // 1 to 3
  activeFilter?: string; // 'all', 'person', 'vehicle'
}

// Internal interface for render state
interface VisualMarker extends Marker {
  currentOpacity: number;
  targetOpacity: number;
  lastUpdated: number;
}

const SKELETON_CONNECTIONS = [
    [0, 1], [0, 2], [1, 3], [2, 4], // Face
    [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], // Arms
    [5, 11], [6, 12], [11, 12], // Torso
    [11, 13], [13, 15], [12, 14], [14, 16] // Legs
];

// Linear Interpolation helper
const lerp = (start: number, end: number, factor: number) => {
  return start + (end - start) * factor;
};

const VideoHUD: React.FC<VideoHUDProps> = React.memo(({ markers: aiMarkers, onVideoFrame, localStream, zoomLevel = 1, activeFilter = 'all' }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const detectionService = useRef<ObjectDetectionService>(new ObjectDetectionService());
  const aiMarkersRef = useRef<Marker[]>([]);
  
  // State for visual interpolation
  const visualStateRef = useRef<Map<string, VisualMarker>>(new Map());

  // Update refs
  useEffect(() => {
    aiMarkersRef.current = aiMarkers;
  }, [aiMarkers]);

  useEffect(() => {
    if (videoRef.current && localStream) {
      videoRef.current.srcObject = localStream;
      videoRef.current.play().catch(e => console.log("Autoplay blocked:", e));
    }
    detectionService.current.load();
  }, [localStream]);

  useEffect(() => {
    if (!offscreenCanvasRef.current) {
        offscreenCanvasRef.current = document.createElement('canvas');
        offscreenCanvasRef.current.width = 480; 
    }
  }, []);

  useEffect(() => {
    let animationFrameId: number;
    let lastFrameTime = 0;
    const FRAME_SEND_INTERVAL = 1000; 

    // Style Constants
    const COLOR_PRIMARY = '#ffaa00'; 
    const COLOR_SECONDARY = '#ffffff';
    const COLOR_BG = '#000000'; 

    const render = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      if (video && canvas && video.readyState >= 2) {
        const dpr = window.devicePixelRatio || 1;
        const rect = video.getBoundingClientRect();
        
        if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
        }

        const ctx = canvas.getContext('2d', { alpha: true });
        
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, rect.width, rect.height);

          // 1. Get Raw Data
          // We get "raw" markers from service (which might be slightly smoothed) and AI
          const detectedMarkers = await detectionService.current.detect(video);
          
          // Combine and Normalize Coordinates to Screen Space
          const scaleX = rect.width / video.videoWidth;
          const scaleY = rect.height / video.videoHeight;

          const currentTargets = new Map<string, Marker>();

          // Helper to check filter
          const matchesFilter = (label: string): boolean => {
              if (activeFilter === 'all') return true;
              if (activeFilter === 'person' && label === 'ЧЕЛОВЕК') return true;
              if (activeFilter === 'vehicle' && ['АВТО', 'ГРУЗ', 'АВТОБУС', 'ВЕЛО', 'БПЛА'].includes(label)) return true;
              return false;
          };

          // Process Local Markers (Convert to screen pixels)
          detectedMarkers.forEach(m => {
              // Apply Filter logic here. Only add to targets if it matches.
              if (!matchesFilter(m.label)) return;

              currentTargets.set(m.id, {
                  ...m,
                  x: m.x * scaleX,
                  y: m.y * scaleY,
                  width: (m.width || 0) * scaleX,
                  height: (m.height || 0) * scaleY,
                  keypoints: m.keypoints?.map(k => ({
                      ...k,
                      x: k.x * scaleX,
                      y: k.y * scaleY
                  }))
              });
          });

          // Process AI Markers (Convert % to screen pixels if needed)
          aiMarkersRef.current.forEach(m => {
               // AI markers usually come as % (0-100) or pixels. Assuming % here if < 100
               let mx = m.x, my = m.y, mw = m.width || 0, mh = m.height || 0;
               if (mx <= 100) {
                   mx = (mx / 100) * rect.width;
                   my = (my / 100) * rect.height;
                   mw = (mw / 100) * rect.width;
                   mh = (mh / 100) * rect.height;
               }
               currentTargets.set(m.id, { ...m, x: mx, y: my, width: mw, height: mh });
          });

          // 2. Update Visual State (The Interpolation Step)
          const now = Date.now();
          const visualState = visualStateRef.current;
          const activeIds = new Set<string>();

          // A. Update Existing or Create New
          currentTargets.forEach((target, id) => {
              activeIds.add(id);
              let visual = visualState.get(id);

              if (!visual) {
                  // Spawn new marker
                  visual = { 
                      ...target, 
                      currentOpacity: 0, 
                      targetOpacity: 1,
                      lastUpdated: now 
                  };
                  visualState.set(id, visual);
              } else {
                  // Mark as active
                  visual.targetOpacity = 1;
                  visual.lastUpdated = now;
                  visual.label = target.label; // Update label in case it changes
                  visual.distance = target.distance;
                  visual.confidence = target.confidence;
                  
                  // --- IMPROVED ADAPTIVE INTERPOLATION ---
                  
                  // 1. Calculate Delta (Pixels moved since last frame)
                  const dx = target.x - visual.x;
                  const dy = target.y - visual.y;
                  const deltaTotal = Math.sqrt(dx*dx + dy*dy);

                  // 2. Deadzone (Hysteresis)
                  if (deltaTotal < 1.5) {
                      // Do nothing
                  } else {
                      // 3. Dynamic LERP Factor
                      const distMeters = target.distance || 5;
                      const baseStability = Math.max(0.08, Math.min(0.25, 1.5 / distMeters));
                      const velocityBoost = Math.min(0.6, (deltaTotal / 100));
                      const finalFactor = baseStability + velocityBoost;

                      // LERP Geometry
                      visual.x = lerp(visual.x, target.x, finalFactor);
                      visual.y = lerp(visual.y, target.y, finalFactor);
                      
                      visual.width = lerp(visual.width || 0, target.width || 0, finalFactor * 0.8);
                      visual.height = lerp(visual.height || 0, target.height || 0, finalFactor * 0.8);
                  }

                  // LERP Skeleton
                  if (target.keypoints && visual.keypoints) {
                      visual.keypoints = visual.keypoints.map((vk, i) => {
                          const tk = target.keypoints![i];
                          if (!tk) return vk;
                          
                          // Keypoints have their own deltas
                          const kdx = tk.x - vk.x;
                          const kdy = tk.y - vk.y;
                          const kDelta = Math.sqrt(kdx*kdx + kdy*kdy);
                          
                          // Apply similar logic to limbs but slightly snappier
                          if (kDelta < 1.0) return vk;
                          
                          const kFactor = 0.2 + Math.min(0.5, kDelta / 50);
                          
                          return {
                              ...tk,
                              x: lerp(vk.x, tk.x, kFactor),
                              y: lerp(vk.y, tk.y, kFactor)
                          };
                      });
                  } else if (target.keypoints) {
                      visual.keypoints = target.keypoints;
                  }
              }
          });

          // B. Handle Disappearing Markers (Fade Out)
          visualState.forEach((visual, id) => {
              if (!activeIds.has(id)) {
                  visual.targetOpacity = 0;
              }
              
              // LERP Opacity
              visual.currentOpacity = lerp(visual.currentOpacity, visual.targetOpacity, 0.15);

              // Garbage Collection
              if (visual.currentOpacity < 0.01 && visual.targetOpacity === 0) {
                  visualState.delete(id);
              }
          });

          // 3. Render Loop (Using Visual State)
          // Re-use loop variables
          let x, y, w, h, depthScale, cornerLen, left, right, top, bottom, jointSize;

          visualState.forEach((m) => {
             // Apply Global Opacity
             ctx.globalAlpha = m.currentOpacity;

             x = m.x; y = m.y; w = m.width || 0; h = m.height || 0;
             
             // Distance Logic for Styling
             const distance = m.distance || 3;
             depthScale = Math.max(0.6, Math.min(2.5, 4 / distance));

             // --- SKELETON RENDER ---
             if (m.shape === 'skeleton' && m.keypoints) {
                 const kp = m.keypoints;
                 const bonePath = new Path2D();
                 let hasVisibleBones = false;

                 for (const [i, j] of SKELETON_CONNECTIONS) {
                    const p1 = kp[i];
                    const p2 = kp[j];
                    if (p1 && p2 && (p1.score ?? 1) > 0.4 && (p2.score ?? 1) > 0.4) {
                        bonePath.moveTo(p1.x, p1.y);
                        bonePath.lineTo(p2.x, p2.y);
                        hasVisibleBones = true;
                    }
                 }

                 if (hasVisibleBones) {
                     ctx.lineCap = 'butt'; 
                     ctx.lineJoin = 'bevel';

                     // Shadow/Glow
                     ctx.shadowBlur = 10 * depthScale;
                     ctx.shadowColor = COLOR_PRIMARY;
                     
                     // Core
                     ctx.strokeStyle = COLOR_PRIMARY;
                     ctx.lineWidth = 2 * depthScale;
                     ctx.stroke(bonePath);
                     
                     ctx.shadowBlur = 0;
                 }

                 // Joints
                 jointSize = 3 * depthScale; 
                 for (const point of kp) {
                     if ((point.score ?? 1) > 0.4) {
                         const jx = point.x;
                         const jy = point.y;
                         
                         ctx.fillStyle = COLOR_SECONDARY;
                         ctx.fillRect(jx - 1.5, jy - 1.5, 3, 3);
                     }
                 }
             } 
             // --- BOX RENDER ---
             else {
                 cornerLen = (Math.min(w, h) * 0.2) * depthScale;
                 left = x - w/2; right = x + w/2;
                 top = y - h/2; bottom = y + h/2;

                 // Box Glow
                 ctx.shadowBlur = 5 * depthScale;
                 ctx.shadowColor = COLOR_PRIMARY;
                 
                 ctx.beginPath();
                 ctx.lineWidth = 2 * depthScale;
                 ctx.strokeStyle = COLOR_PRIMARY;

                 // Draw corners only
                 ctx.moveTo(left, top + cornerLen); ctx.lineTo(left, top); ctx.lineTo(left + cornerLen, top);
                 ctx.moveTo(right - cornerLen, top); ctx.lineTo(right, top); ctx.lineTo(right, top + cornerLen);
                 ctx.moveTo(right, bottom - cornerLen); ctx.lineTo(right, bottom); ctx.lineTo(right - cornerLen, bottom);
                 ctx.moveTo(left + cornerLen, bottom); ctx.lineTo(left, bottom); ctx.lineTo(left, bottom - cornerLen);
                 ctx.stroke();
                 
                 ctx.shadowBlur = 0;
             }

             // --- LABEL RENDER ---
             if (m.label) {
                 const scaledFontSize = Math.max(8, Math.min(16, 10 * depthScale));
                 ctx.font = `${Math.floor(scaledFontSize)}px "Press Start 2P"`;
                 ctx.textAlign = 'center';
                 ctx.textBaseline = 'bottom';
                 
                 const labelText = `${m.label.toUpperCase()} ${m.distance ? `[${m.distance}M]` : ''}`;
                 const textY = (y - h/2) - (8 * depthScale);
                 
                 // Text Outline
                 ctx.lineWidth = 3;
                 ctx.strokeStyle = 'black';
                 ctx.strokeText(labelText, x, textY);
                 
                 ctx.fillStyle = COLOR_PRIMARY;
                 ctx.fillText(labelText, x, textY);
             }
          });
          
          ctx.globalAlpha = 1.0; // Reset alpha

          // Static Center Crosshair
          const cx = rect.width / 2;
          const cy = rect.height / 2;
          
          ctx.lineWidth = 2;
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
          ctx.beginPath();
          ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
          ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
          ctx.stroke();

          ctx.strokeStyle = 'rgba(255, 170, 0, 0.4)';
          ctx.beginPath();
          ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy);
          ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8);
          ctx.stroke();
        }

        // 3. Send Frame to AI
        const now = Date.now();
        if (now - lastFrameTime > FRAME_SEND_INTERVAL) {
            lastFrameTime = now;
            const osc = offscreenCanvasRef.current;
            if (osc) {
                const scale = osc.width / video.videoWidth; 
                osc.height = video.videoHeight * scale;
                const oCtx = osc.getContext('2d');
                if (oCtx) {
                    oCtx.drawImage(video, 0, 0, osc.width, osc.height);
                    const base64 = osc.toDataURL('image/jpeg', 0.5).split(',')[1];
                    onVideoFrame(base64);
                }
            }
        }
      }
      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [onVideoFrame, zoomLevel, activeFilter]); 

  // CSS Transform for Digital Zoom
  // We transform the CONTAINER, not just the video, so markers line up.
  const containerStyle = {
      transform: `scale(${zoomLevel})`,
      transformOrigin: 'center center',
      transition: 'transform 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
  };

  return (
    <div className="relative w-full h-full bg-black flex justify-center items-center overflow-hidden">
      {/* Container for Zoomable Content */}
      <div className="absolute w-full h-full" style={containerStyle}>
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute w-full h-full object-cover"
          />
          <canvas
            ref={canvasRef}
            className="absolute w-full h-full object-cover pointer-events-none z-10"
          />
      </div>

      {/* Visual Effects Layer (Not Zoomed) */}
      <div className="absolute inset-0 pointer-events-none z-20">
          <div className="scanline"></div>
          <div className="vignette w-full h-full"></div>
          <div className="absolute inset-0 opacity-10" style={{ 
              backgroundImage: 'linear-gradient(#000 1px, transparent 1px), linear-gradient(90deg, #000 1px, transparent 1px)',
              backgroundSize: '4px 4px'
          }}></div>
      </div>
      
      <div className="absolute bottom-6 left-6 pointer-events-none text-[8px] md:text-[10px] leading-none z-30 pb-safe-bottom">
          <div className="text-orange-500 pixel-text-shadow font-bold">
            СИСТЕМА: <span className="text-orange-100 animate-pulse">ОНЛАЙН</span>
          </div>
          {activeFilter !== 'all' && (
              <div className="text-red-500 font-bold mt-1 animate-pulse">
                ЦЕЛЕУКАЗАНИЕ: {activeFilter.toUpperCase()}
              </div>
          )}
      </div>
      <style>{`
        .pb-safe-bottom {
            padding-bottom: max(1rem, env(safe-area-inset-bottom));
        }
      `}</style>
    </div>
  );
});

export default VideoHUD;
