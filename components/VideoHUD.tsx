import React, { useEffect, useRef, useState } from 'react';
import { Marker } from '../types';
import { ObjectDetectionService } from '../services/objectDetectionService';

interface VideoHUDProps {
  markers: Marker[]; 
  onVideoFrame: (base64: string) => void;
  localStream: MediaStream | null;
  zoomLevel?: number; 
  activeFilter?: string; 
  visualMode?: string; 
}

// --- RENDER WORKER (Runs in a separate thread for 60FPS UI) ---
const RENDER_WORKER_CODE = `
  let ctx = null;
  let canvasWidth = 0;
  let canvasHeight = 0;
  
  // State
  let markers = [];
  let visualState = new Map(); 
  
  // IMU Stabilization State
  let currentOrientation = { alpha: 0, beta: 0, gamma: 0 };
  let anchorOrientation = { alpha: 0, beta: 0, gamma: 0 }; 
  let orientationInitialized = false;

  let zoomLevel = 1;
  let lastTime = 0;
  let visualMode = 'normal';
  let tick = 0;
  
  // Constants
  const COLOR_PRIMARY = '#ffaa00';
  const COLOR_DANGER = '#ff3300';
  const COLOR_MACHINE = '#00ff41'; 
  const COLOR_FACE = '#00ffff'; // Cyan for face analysis

  const SKELETON_CONNECTIONS = [
      [0, 1], [0, 2], [1, 3], [2, 4], 
      [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], 
      [5, 11], [6, 12], [11, 12], 
      [11, 13], [13, 15], [12, 14], [14, 16]
  ];
  
  const KEYPOINT_NAMES = {
      0: 'HEAD',
      9: 'R_HAND',
      10: 'L_HAND', 
      15: 'R_FOOT',
      16: 'L_FOOT'
  };

  const LERP_FACTOR = 0.35; 
  const PERSISTENCE_MS = 500; // Time markers stay before fading

  const lerp = (start, end, factor) => start + (end - start) * factor;

  self.onmessage = (e) => {
    const { type, payload } = e.data;

    if (type === 'INIT') {
      const canvas = payload.canvas;
      ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
      canvasWidth = canvas.width;
      canvasHeight = canvas.height;
      requestAnimationFrame(loop);
    }
    else if (type === 'RESIZE') {
      canvasWidth = payload.width;
      canvasHeight = payload.height;
      if (ctx) {
         ctx.canvas.width = payload.width;
         ctx.canvas.height = payload.height;
      }
    }
    else if (type === 'UPDATE_MARKERS') {
      markers = payload;
      // Resync anchor to current orientation as markers are "ground truth" for now.
      if (orientationInitialized) {
          anchorOrientation = { ...currentOrientation };
      }
    }
    else if (type === 'UPDATE_SENSORS') {
      const a = 0.1; // Smoothing factor
      if (!orientationInitialized) {
         currentOrientation = payload.orientation;
         anchorOrientation = payload.orientation;
         orientationInitialized = true;
      } else {
         const raw = payload.orientation;
         
         // Handle Alpha (Yaw) Wrap-around for LERP
         let dAlpha = raw.alpha - currentOrientation.alpha;
         if (dAlpha > 180) dAlpha -= 360;
         if (dAlpha < -180) dAlpha += 360;
         currentOrientation.alpha += dAlpha * a;
         // Normalize alpha
         if (currentOrientation.alpha < 0) currentOrientation.alpha += 360;
         if (currentOrientation.alpha >= 360) currentOrientation.alpha -= 360;

         currentOrientation.beta = lerp(currentOrientation.beta, raw.beta, a);
         currentOrientation.gamma = lerp(currentOrientation.gamma, raw.gamma, a);
      }
      zoomLevel = payload.zoom;
    }
    else if (type === 'UPDATE_MODE') {
      visualMode = payload;
    }
  };

  function drawGrid(ctx, w, h, roll, pitchOffset) {
      ctx.save();
      ctx.translate(w/2, h/2);
      ctx.rotate(roll);
      ctx.translate(0, pitchOffset);
      
      const speed = (Date.now() / 50) % 50;
      ctx.strokeStyle = 'rgba(0, 255, 65, 0.15)';
      ctx.lineWidth = 1;
      
      ctx.beginPath();
      // Longitudinal lines
      for(let i=-20; i<=20; i++) {
          const x = i * 40 * zoomLevel;
          ctx.moveTo(x, -h * 2); 
          ctx.lineTo(x * 3, h * 2); 
      }
      // Latitudinal lines
      for(let i=0; i<20; i++) {
          const y = (Math.pow(i, 1.8) * 5 * zoomLevel) + speed;
          if (y > h) continue;
          ctx.moveTo(-w * 2, y);
          ctx.lineTo(w * 2, y);
      }
      ctx.stroke();
      ctx.restore();
  }
  
  function drawPath(ctx, points, shiftX, shiftY, close = false, fill = false) {
      if (!points || points.length === 0) return;
      ctx.beginPath();
      ctx.moveTo(points[0].x + shiftX, points[0].y + shiftY);
      for(let i=1; i<points.length; i++) {
          ctx.lineTo(points[i].x + shiftX, points[i].y + shiftY);
      }
      if (close) ctx.closePath();
      if (fill) ctx.fill();
      ctx.stroke();
  }

  function loop(timestamp) {
    if (!ctx) {
        requestAnimationFrame(loop);
        return;
    }
    
    tick++;
    const dt = timestamp - lastTime;
    lastTime = timestamp;
    const now = Date.now();

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    const cx = canvasWidth / 2;
    const cy = canvasHeight / 2;
    
    const degPerPixelX = 60 / canvasWidth; 
    const degPerPixelY = 45 / canvasHeight; 
    const ppdY = 1 / degPerPixelY;
    const ppdX = 1 / degPerPixelX;

    const rollRad = (currentOrientation.gamma * Math.PI) / 180;
    const pitchOffset = currentOrientation.beta * ppdY * zoomLevel;

    const isWireframe = visualMode === 'wireframe';
    const isMachine = visualMode === 'machine';
    
    const mainColor = isWireframe ? '#ffffff' : (isMachine ? COLOR_MACHINE : COLOR_PRIMARY);
    const dangerColor = isWireframe ? '#ff0000' : COLOR_DANGER;

    let shiftX = 0;
    let shiftY = 0;

    if (orientationInitialized) {
        let dAlpha = currentOrientation.alpha - anchorOrientation.alpha;
        if (dAlpha > 180) dAlpha -= 360;
        if (dAlpha < -180) dAlpha += 360;
        const dBeta = currentOrientation.beta - anchorOrientation.beta;
        shiftX = -(dAlpha * ppdX);
        shiftY = -(dBeta * ppdY);
    }
    
    if (isMachine || isWireframe) {
        drawGrid(ctx, canvasWidth, canvasHeight, rollRad, pitchOffset);
    }

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rollRad);
    ctx.translate(0, pitchOffset);

    // Horizon & Pitch Ladder
    ctx.strokeStyle = isMachine || isWireframe ? 'rgba(0, 255, 65, 0.3)' : 'rgba(255, 170, 0, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(-cx * 4, 0); ctx.lineTo(cx * 4, 0); ctx.stroke();
    
    for (let i = -2; i <= 2; i++) {
        if (i === 0) continue;
        const y = i * 15 * ppdY * zoomLevel;
        const w = 50;
        ctx.beginPath(); ctx.moveTo(-w, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = '10px monospace';
        ctx.fillText(i * 15 + '°', w + 5, y + 3);
    }
    ctx.restore();

    // --- DRAW MARKERS ---
    const activeIds = new Set();
    
    markers.forEach(m => {
        activeIds.add(m.id);
        let visual = visualState.get(m.id);
        
        if (!visual) {
            visual = { ...m, currentOpacity: 0, targetOpacity: 1, lastSeen: now };
            visualState.set(m.id, visual);
        } else {
            visual.targetOpacity = 1;
            visual.lastSeen = now;
            visual.x = lerp(visual.x, m.x, LERP_FACTOR);
            visual.y = lerp(visual.y, m.y, LERP_FACTOR);
            visual.width = lerp(visual.width || 0, m.width || 0, LERP_FACTOR);
            visual.height = lerp(visual.height || 0, m.height || 0, LERP_FACTOR);
            visual.label = m.label;
            visual.distance = m.distance;
            visual.keypoints = m.keypoints;
            visual.contours = m.contours;
        }
    });

    visualState.forEach((m, id) => {
        if (!activeIds.has(id)) {
            if (now - m.lastSeen < PERSISTENCE_MS) { m.targetOpacity = 1; } 
            else { m.targetOpacity = 0; }
        }
        m.currentOpacity = lerp(m.currentOpacity, m.targetOpacity, 0.15);
        if (m.currentOpacity < 0.05) { visualState.delete(id); return; }

        ctx.globalAlpha = m.currentOpacity;
        
        // Final position with stabilization
        const x = m.x + shiftX; 
        const y = m.y + shiftY; 
        
        if (x < -200 || x > canvasWidth + 200 || y < -200 || y > canvasHeight + 200) return;

        const w = m.width; 
        const h = m.height;
        const depthScale = Math.max(0.6, Math.min(2.5, 4 / (m.distance || 3)));
        
        const baseColor = m.label === 'УГРОЗА' ? dangerColor : mainColor;
        
        // Perspective Box Calculation
        const perspective = 0.85; 
        const vx = x - cx; const vy = y - cy;
        const bx = cx + vx * perspective; const by = cy + vy * perspective; 
        const bw = w * perspective; const bh = h * perspective; 
        
        const fl = x - w/2, fr = x + w/2; const ft = y - h/2, fb = y + h/2;
        const bl = bx - bw/2, br = bx + bw/2; const bt = by - bh/2, bb = by + bh/2;

        if (m.shape === 'face_mesh' && m.contours) {
             const meshColor = isWireframe ? '#00ffff' : (isMachine ? '#00ffaa' : COLOR_FACE);
             
             // --- FACE MESH (Mask) ---
             ctx.strokeStyle = meshColor;
             ctx.lineWidth = (isWireframe ? 1.5 : 1) * depthScale;
             
             if (m.contours.silhouette) drawPath(ctx, m.contours.silhouette, shiftX, shiftY, true);

             // Features
             ctx.fillStyle = isWireframe ? 'rgba(0, 255, 255, 0.1)' : 'rgba(0, 255, 255, 0.05)';
             ctx.lineWidth = (isWireframe ? 2 : 1.5) * depthScale;
             
             if (m.contours.lipsUpper && m.contours.lipsLower) {
                 drawPath(ctx, m.contours.lipsUpper, shiftX, shiftY, true, true);
                 drawPath(ctx, m.contours.lipsLower, shiftX, shiftY, true, true);
             }

             if (m.contours.rightEye) drawPath(ctx, m.contours.rightEye, shiftX, shiftY, true, true);
             if (m.contours.leftEye) drawPath(ctx, m.contours.leftEye, shiftX, shiftY, true, true);

             ctx.fillStyle = 'transparent';
             if (m.contours.rightEyebrow) drawPath(ctx, m.contours.rightEyebrow, shiftX, shiftY, false);
             if (m.contours.leftEyebrow) drawPath(ctx, m.contours.leftEyebrow, shiftX, shiftY, false);
             if (m.contours.nose) drawPath(ctx, m.contours.nose, shiftX, shiftY, false);

             // Frame Corners
             const cornerSize = w * 0.2;
             ctx.strokeStyle = meshColor;
             ctx.lineWidth = 2 * depthScale;
             ctx.beginPath(); ctx.moveTo(fl, ft + cornerSize); ctx.lineTo(fl, ft); ctx.lineTo(fl + cornerSize, ft); ctx.stroke();
             ctx.beginPath(); ctx.moveTo(fr, ft + cornerSize); ctx.lineTo(fr, ft); ctx.lineTo(fr - cornerSize, ft); ctx.stroke();
             ctx.beginPath(); ctx.moveTo(fl, fb - cornerSize); ctx.lineTo(fl, fb); ctx.lineTo(fl + cornerSize, fb); ctx.stroke();
             ctx.beginPath(); ctx.moveTo(fr, fb - cornerSize); ctx.lineTo(fr, fb); ctx.lineTo(fr - cornerSize, fb); ctx.stroke();

        } else if (m.shape === 'skeleton' && m.keypoints) {
             // --- SKELETON ---
             ctx.strokeStyle = baseColor;
             // Increased line width for better mobile visibility
             ctx.lineWidth = (isWireframe ? 4 : 3) * depthScale;
             ctx.lineJoin = 'round'; ctx.lineCap = 'round';

             ctx.beginPath();
             for (const [i, j] of SKELETON_CONNECTIONS) {
                const p1 = m.keypoints[i]; const p2 = m.keypoints[j];
                // Increased threshold to 0.6 for better quality
                if (p1 && p2 && p1.score > 0.6 && p2.score > 0.6) {
                    ctx.moveTo(p1.x + shiftX, p1.y + shiftY); ctx.lineTo(p2.x + shiftX, p2.y + shiftY);
                }
             }
             ctx.stroke();

             // Nodes
             m.keypoints.forEach((k, idx) => {
                 // Increased threshold to 0.6
                 if (k.score > 0.6) {
                     const kx = k.x + shiftX;
                     const ky = k.y + shiftY;
                     
                     ctx.fillStyle = '#000';
                     ctx.strokeStyle = baseColor;
                     ctx.lineWidth = 1.5;
                     ctx.beginPath();
                     ctx.arc(kx, ky, 4 * depthScale, 0, Math.PI * 2);
                     ctx.fill();
                     ctx.stroke();

                     if (KEYPOINT_NAMES[idx]) {
                         ctx.fillStyle = baseColor;
                         ctx.font = (10 * depthScale) + 'px monospace';
                         ctx.fillText(KEYPOINT_NAMES[idx], kx + 8, ky);
                     }
                 }
             });

        } else {
             // --- BOX ---
             if (!isWireframe) {
                 ctx.fillStyle = m.label === 'УГРОЗА' ? 'rgba(255, 0, 0, 0.15)' : (isMachine ? 'rgba(0, 255, 65, 0.1)' : 'rgba(255, 170, 0, 0.1)');
                 ctx.beginPath(); ctx.moveTo(fl, fb); ctx.lineTo(bl, bb); ctx.lineTo(br, bb); ctx.lineTo(fr, fb); ctx.fill();
             }

             ctx.strokeStyle = isMachine || isWireframe ? 'rgba(0,255,65,0.8)' : 'rgba(255,170,0,0.3)';
             ctx.lineWidth = isWireframe ? 2 : 1;
             ctx.beginPath();
             ctx.moveTo(fl, ft); ctx.lineTo(bl, bt);
             ctx.moveTo(fr, ft); ctx.lineTo(br, bt);
             ctx.moveTo(fr, fb); ctx.lineTo(br, bb);
             ctx.moveTo(fl, fb); ctx.lineTo(bl, bb);
             ctx.stroke();
             
             if (!isWireframe) {
                 ctx.strokeStyle = 'rgba(255,255,255,0.1)';
                 ctx.strokeRect(bl, bt, bw, bh);
             }
        }

        // --- LABELS ---
        if (m.label) {
             const lx = fr + 10;
             const ly = ft;
             ctx.beginPath(); ctx.moveTo(fr, ft); ctx.lineTo(lx, ly - 20); ctx.lineTo(lx + 40, ly - 20);
             ctx.strokeStyle = baseColor; ctx.lineWidth = 1; ctx.stroke();

             ctx.fillStyle = baseColor;
             ctx.font = 'bold ' + (12 * depthScale) + 'px monospace';
             ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
             ctx.fillText(m.label, lx + 5, ly - 22);
             
             ctx.font = (10 * depthScale) + 'px monospace';
             ctx.fillStyle = 'rgba(255,255,255,0.8)';
             ctx.fillText((m.distance || '?') + 'M [' + Math.floor((m.confidence||0)*100) + '%]', lx, ly - 8);
        }
    });
    
    requestAnimationFrame(loop);
  }
`;

const VideoHUD: React.FC<VideoHUDProps> = React.memo(({ markers: aiMarkers, onVideoFrame, localStream, zoomLevel = 1, activeFilter = 'all', visualMode = 'normal' }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const snapshotCanvasRef = useRef<OffscreenCanvas | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const detectionServiceRef = useRef<ObjectDetectionService | null>(null);

  // Loading State
  const [loadingStatus, setLoadingStatus] = useState<{label: string, value: number} | null>({label: 'INIT', value: 0});

  // 1. Initialize Render Worker
  useEffect(() => {
    if (!canvasRef.current) return;
    const blob = new Blob([RENDER_WORKER_CODE], { type: 'text/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    workerRef.current = worker;
    try {
        const offscreen = canvasRef.current.transferControlToOffscreen();
        worker.postMessage({ type: 'INIT', payload: { canvas: offscreen } }, [offscreen]);
    } catch (e) { }
    return () => { worker.terminate(); workerRef.current = null; };
  }, []);

  // 2. Initialize Detection
  useEffect(() => {
      const service = new ObjectDetectionService();
      detectionServiceRef.current = service;

      service.onProgress = (label, value) => {
          setLoadingStatus({ label, value });
          if (value >= 1.0) {
              setTimeout(() => setLoadingStatus(null), 1000);
          }
      };
      service.load();
      return () => {
          service.dispose();
          detectionServiceRef.current = null;
      };
  }, []);

  // 3. Update Video
  useEffect(() => {
      if (videoRef.current && localStream) {
          videoRef.current.srcObject = localStream;
          videoRef.current.play().catch(e => console.log("Autoplay:", e));
      }
  }, [localStream]);

  // 4. Handle Resize
  useEffect(() => {
    const handleResize = () => {
        if (videoRef.current && workerRef.current) {
            const rect = videoRef.current.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            workerRef.current.postMessage({ type: 'RESIZE', payload: { width: rect.width * dpr, height: rect.height * dpr } });
        }
    };
    const ro = new ResizeObserver(handleResize);
    if (videoRef.current) ro.observe(videoRef.current);
    return () => ro.disconnect();
  }, []);

  // 5. Sensors & Modes
  useEffect(() => {
      const handleOrientation = (event: DeviceOrientationEvent) => {
          if (workerRef.current) {
              workerRef.current.postMessage({ type: 'UPDATE_SENSORS', payload: { orientation: { alpha: event.alpha || 0, beta: event.beta || 0, gamma: event.gamma || 0 }, zoom: zoomLevel } });
          }
      };
      if (workerRef.current) workerRef.current.postMessage({ type: 'UPDATE_MODE', payload: visualMode });
      window.addEventListener('deviceorientation', handleOrientation);
      return () => window.removeEventListener('deviceorientation', handleOrientation);
  }, [zoomLevel, visualMode]);

  // 6. Main Detection Loop (Corrected for Object-Cover)
  useEffect(() => {
    if (!snapshotCanvasRef.current && window.OffscreenCanvas) {
        snapshotCanvasRef.current = new OffscreenCanvas(480, 360);
    }

    let isMounted = true;
    let lastFrameTime = 0;
    const FRAME_SEND_INTERVAL = 800; 

    const processFrame = async () => {
        if (!isMounted) return;
        
        const video = videoRef.current;
        const detectionService = detectionServiceRef.current;
        
        if (video && video.readyState >= 2 && detectionService) {
             const rawMarkers = await detectionService.detect(video);
             
             // --- FIX COORDINATE MAPPING FOR OBJECT-COVER ---
             const rect = video.getBoundingClientRect();
             const screenW = rect.width;
             const screenH = rect.height;
             const vidW = video.videoWidth;
             const vidH = video.videoHeight;

             // Calculate scaling to fill container (object-cover)
             const scale = Math.max(screenW / vidW, screenH / vidH);
             // Offsets to center video
             const offsetX = (screenW - vidW * scale) / 2;
             const offsetY = (screenH - vidH * scale) / 2;
             
             const processedMarkers: Marker[] = [];
             const filterVal = activeFilter; 
             const matchesFilter = (label: string) => {
                if (filterVal === 'all') return true;
                if (filterVal === 'person' && (label === 'ЧЕЛОВЕК' || label === 'ЛИЦО' || label === 'РЕЧЬ' || label === 'ТЕЛО')) return true;
                if (filterVal === 'vehicle' && ['АВТО', 'ГРУЗ', 'АВТОБУС'].includes(label)) return true;
                return false;
             };

             rawMarkers.forEach(m => {
                 if (matchesFilter(m.label)) {
                     // Transform logic: 
                     // m.x is original pixel in Video.
                     // displayedPixel = (originalPixel * scale) + offset
                     
                     // Helper for points
                     const transformX = (x: number) => (x * scale) + offsetX;
                     const transformY = (y: number) => (y * scale) + offsetY;

                     processedMarkers.push({
                         ...m,
                         x: transformX(m.x),
                         y: transformY(m.y),
                         width: (m.width || 0) * scale,
                         height: (m.height || 0) * scale,
                         keypoints: m.keypoints?.map(k => ({ ...k, x: transformX(k.x), y: transformY(k.y) })),
                         contours: m.contours ? processContours(m.contours, scale, offsetX, offsetY) : undefined
                     });
                 }
             });

             // Merge AI markers (assuming 0-100 percentage)
             aiMarkers.forEach(m => {
                 let mx = m.x, my = m.y, mw = m.width || 0, mh = m.height || 0;
                 if (mx <= 100) {
                     mx = (mx / 100) * screenW;
                     my = (my / 100) * screenH;
                     mw = (mw / 100) * screenW;
                     mh = (mh / 100) * screenH;
                 }
                 processedMarkers.push({ ...m, x: mx, y: my, width: mw, height: mh });
             });

             if (workerRef.current) {
                 workerRef.current.postMessage({ type: 'UPDATE_MARKERS', payload: processedMarkers });
             }

             const now = Date.now();
             if (now - lastFrameTime > FRAME_SEND_INTERVAL) {
                 lastFrameTime = now;
                 const osc = snapshotCanvasRef.current;
                 if (osc) {
                     const ctx = osc.getContext('2d', { willReadFrequently: true });
                     if (ctx) {
                         ctx.drawImage(video, 0, 0, osc.width, osc.height);
                         osc.convertToBlob({ type: 'image/jpeg', quality: 0.4 }).then(blob => {
                             if (!isMounted) return;
                             const reader = new FileReader();
                             reader.onloadend = () => {
                                 const base64 = (reader.result as string)?.split(',')[1];
                                 if (base64) onVideoFrame(base64);
                             };
                             reader.readAsDataURL(blob);
                         }).catch(() => {});
                     }
                 }
             }
        }
        
        requestAnimationFrame(processFrame);
    };

    requestAnimationFrame(processFrame);
    return () => { isMounted = false; };
  }, [aiMarkers, activeFilter, onVideoFrame]); 

  const processContours = (contours: any, scale: number, offX: number, offY: number) => {
      const processed: any = {};
      for(const [key, points] of Object.entries(contours)) {
          processed[key] = (points as any[]).map(p => ({
              x: (p.x * scale) + offX,
              y: (p.y * scale) + offY
          }));
      }
      return processed;
  };

  let videoFilter = 'none';
  if (visualMode === 'night') videoFilter = 'grayscale(100%) sepia(100%) hue-rotate(90deg) brightness(1.2) contrast(1.1)'; 
  else if (visualMode === 'thermal') videoFilter = 'grayscale(100%) contrast(1.5) brightness(0.8) sepia(100%) hue-rotate(-50deg)'; 
  else if (visualMode === 'matrix') videoFilter = 'grayscale(100%) brightness(0.8) contrast(1.5)'; 
  else if (visualMode === 'machine') videoFilter = 'grayscale(100%) invert(100%) contrast(150%) brightness(0.2)'; 

  return (
    <div className="relative w-full h-full bg-black flex justify-center items-center overflow-hidden">
      <div 
        ref={containerRef}
        className="absolute w-full h-full transition-transform duration-100 ease-out will-change-transform"
        style={{ transformStyle: 'preserve-3d' }}
      >
          <div className="absolute w-full h-full" style={{ transform: 'translateZ(-50px)', backfaceVisibility: 'hidden' }}>
            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`w-full h-full object-cover transition-opacity duration-300 ${visualMode === 'wireframe' ? 'opacity-0' : 'opacity-100'}`}
                style={{ filter: videoFilter }} 
            />
          </div>
          <canvas
            ref={canvasRef}
            className="absolute w-full h-full object-cover pointer-events-none z-10"
            style={{ transform: 'translateZ(0px)' }}
          />
      </div>

      <div className="absolute inset-0 pointer-events-none z-20">
          <div className="scanline"></div>
          <div className={`vignette w-full h-full ${visualMode === 'night' ? 'bg-green-900/10' : ''}`}></div>
      </div>
      
      {/* Loading Progress Bars */}
      {loadingStatus && (
          <div className="absolute top-20 right-4 w-48 z-40 flex flex-col items-end gap-1 pointer-events-none animate-pulse">
              <div className="text-[10px] text-orange-500 font-bold bg-black/70 px-2 py-1 pixel-text-shadow">
                  SYSTEM_BOOT: {loadingStatus.label}
              </div>
              <div className="w-full h-2 bg-gray-900 border border-orange-900">
                  <div 
                      className="h-full bg-orange-500 transition-all duration-200"
                      style={{ width: `${(loadingStatus.value || 0) * 100}%` }}
                  />
              </div>
          </div>
      )}
    </div>
  );
});

export default VideoHUD;