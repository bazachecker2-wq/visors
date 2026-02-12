
import { Marker } from '../types';
import { ObjectDetectionService } from '../services/objectDetectionService';
import React, { useEffect, useRef, useCallback } from 'react';

interface VideoHUDProps {
  markers: Marker[];
  onVideoFrame: (base64: string) => void;
  onAddManualMarker?: (x: number, y: number) => void;
  localStream: MediaStream | null;
  zoomLevel?: number;
  visualMode?: string;
  xrMode?: boolean;
}

const RENDER_WORKER_CODE = `
  let ctx = null, canvasW = 0, canvasH = 0, markers = [], state = new Map();
  let currentOri = { a: 0, b: 0 }, anchorOri = { a: 0, b: 0 }, oriInit = false;
  let zoom = 1, mode = 'normal', xr = false, lastTime = performance.now();

  const f = 12.0; 
  const z = 0.55;  
  const r = 2.2;  

  const k1 = z / (Math.PI * f);
  const k2 = 1 / ((2 * Math.PI * f) * (2 * Math.PI * f));
  const k3 = r * z / (2 * Math.PI * f);
  const H_FOV = 60;

  const POSE_CONNECTIONS = [
    [5, 6], [5, 7], [7, 9], [6, 8], [8, 10], 
    [11, 12], [5, 11], [6, 12], 
    [11, 13], [13, 15], [12, 14], [14, 16]
  ];

  function updateSecondOrder(v, target, dt) {
    const T = Math.min(dt / 1000, 0.016);
    const x = v.current;
    const x_dot = v.vel;
    const x_target = target;
    const x_target_dot = (x_target - v.lastTarget) / (T || 0.001);
    v.lastTarget = x_target;
    
    const iterations = 3; 
    const h = T / iterations;
    for(let i=0; i<iterations; i++) {
        const acceleration = (x_target + k3 * x_target_dot - x - k1 * x_dot) / k2;
        v.vel = v.vel + h * acceleration;
        v.current = v.current + h * v.vel;
    }
    return v.current;
  }

  function getAlphaDiff(a1, a2) {
    let diff = a1 - a2;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return diff;
  }

  function getMarkerColor(id, d, baseAccent) {
      if (id.startsWith('manual')) return '#ff3333';
      const hash = id.split('').reduce((acc, char) => char.charCodeAt(0) + ((acc << 5) - acc), 0);
      const hue = Math.abs(hash % 360);
      return mode === 'thermal' ? '#ffffff' : (mode === 'machine' ? "hsl(" + hue + ", 100%, 50%)" : (d < 5 ? '#ff0000' : baseAccent));
  }

  self.onmessage = (e) => {
    const { type, payload } = e.data;
    if (type === 'INIT') {
      ctx = payload.canvas.getContext('2d', { alpha: true, desynchronized: true });
      canvasW = payload.canvas.width; canvasH = payload.canvas.height;
      requestAnimationFrame(loop);
    } else if (type === 'UPDATE_MARKERS') {
      markers = payload;
    } else if (type === 'UPDATE_SENSORS') {
      if (!oriInit && payload.ori.alpha !== null) { 
        anchorOri = { a: payload.ori.alpha, b: payload.ori.beta }; 
        oriInit = true; 
      }
      currentOri = { a: payload.ori.alpha, b: payload.ori.beta };
      zoom = payload.zoom;
    } else if (type === 'UPDATE_MODE') { 
        mode = payload.mode; 
        xr = payload.xr;
    }
  };

  function renderView(viewX, viewY, viewW, viewH, ipdOffset) {
    const da = getAlphaDiff(currentOri.a, anchorOri.a);
    const db = currentOri.b - anchorOri.b;
    const currentFOV = H_FOV / zoom;
    const viewOffsetX = da / currentFOV;
    const viewOffsetY = db / (currentFOV * (viewH/viewW));

    const colors = { machine: '#00ff41', thermal: '#ffffff', normal: '#ffaa00' };
    const baseAccent = colors[mode] || colors.normal;

    ctx.save();
    ctx.beginPath(); ctx.rect(viewX, viewY, viewW, viewH); ctx.clip();
    ctx.translate(viewX + ipdOffset, viewY);

    state.forEach(v => {
      v.op += (v.active ? 0.3 : -v.op) * 0.15;
      if (v.op < 0.01) return;

      const cx = (v.x.current - viewOffsetX) * viewW;
      const cy = (v.y.current - viewOffsetY) * viewH;
      const d = v.dist.current;
      const dScale = 1 / (1 + d * 0.08);
      const hw = (v.w.current * viewW)/2, hh = (v.h.current * viewH)/2;

      ctx.save();
      ctx.globalAlpha = Math.min(1, v.op);
      
      const markerAccent = v.color || getMarkerColor(v.id, d, baseAccent);

      // GROUND PIN
      if (mode !== 'thermal') {
          ctx.beginPath();
          ctx.strokeStyle = markerAccent;
          ctx.globalAlpha = 0.4 * v.op;
          ctx.lineWidth = 1;
          ctx.moveTo(cx, cy + hh);
          ctx.lineTo(cx, cy + hh + 30 * dScale);
          ctx.stroke();
          ctx.globalAlpha = v.op;
      }

      // BIO JITTER
      let jitX = 0, jitY = 0;
      if (v.label.includes('ГУМ') || v.label.includes('БИО')) {
          jitX = Math.sin(performance.now() * 0.01) * 0.8;
          jitY = Math.cos(performance.now() * 0.012) * 0.8;
      }

      // SKELETON
      if (v.keypoints && v.keypoints.length > 0) {
          ctx.strokeStyle = mode === 'thermal' ? '#00ffff' : markerAccent;
          ctx.lineWidth = 2.5 * dScale;
          ctx.lineCap = 'round';
          
          POSE_CONNECTIONS.forEach(([i1, i2]) => {
              const k1 = v.keypoints[i1]; const k2 = v.keypoints[i2];
              if (k1 && k2 && k1.score > 0.3 && k2.score > 0.3) {
                  const x1 = (k1.x - viewOffsetX) * viewW; const y1 = (k1.y - viewOffsetY) * viewH;
                  const x2 = (k2.x - viewOffsetX) * viewW; const y2 = (k2.y - viewOffsetY) * viewH;
                  ctx.beginPath(); ctx.moveTo(x1 + jitX, y1 + jitY); ctx.lineTo(x2 + jitX, y2 + jitY); ctx.stroke();
              }
          });
      }

      ctx.translate(cx + jitX, cy + jitY);

      if (v.source === 'manual') {
          ctx.strokeStyle = markerAccent; ctx.lineWidth = 2.5;
          ctx.beginPath(); ctx.arc(0, 0, 10, 0, 6.28); ctx.stroke();
          ctx.fillStyle = markerAccent; ctx.font = 'bold 10px monospace';
          ctx.fillText(v.label || 'ЦЕЛЬ', 14, 4);
      } else {
          ctx.strokeStyle = markerAccent;
          ctx.lineWidth = 2 * dScale;
          const cl = 12 * dScale;
          
          ctx.beginPath();
          ctx.moveTo(-hw, -hh+cl); ctx.lineTo(-hw, -hh); ctx.lineTo(-hw+cl, -hh);
          ctx.moveTo(hw-cl, -hh); ctx.lineTo(hw, -hh); ctx.lineTo(hw, -hh+cl);
          ctx.moveTo(hw, hh-cl); ctx.lineTo(hw, hh); ctx.lineTo(hw-cl, hh);
          ctx.moveTo(-hw+cl, hh); ctx.lineTo(-hw, hh); ctx.lineTo(-hw, hh-cl);
          ctx.stroke();

          ctx.font = 'bold ' + Math.max(10, 14 * dScale) + 'px monospace';
          ctx.fillStyle = markerAccent;
          ctx.fillText(v.label, -hw, -hh - 12);
          
          if (v.activity) {
              const actText = v.activity.toUpperCase();
              ctx.font = 'bold 9px monospace';
              const tw = ctx.measureText(actText).width;
              ctx.fillStyle = markerAccent;
              ctx.globalAlpha = 0.85;
              ctx.fillRect(hw + 8, -hh, tw + 12, 16);
              ctx.fillStyle = '#000';
              ctx.fillText(actText, hw + 14, -hh + 11);
              ctx.globalAlpha = v.op;
          }

          ctx.fillStyle = mode === 'thermal' ? '#ff00ff' : '#00ffff'; 
          ctx.font = '9px monospace';
          const tel = "[" + d.toFixed(1) + "M] " + (v.speed > 1 ? v.speed + "KM/H" : "");
          ctx.fillText(tel, -hw, hh + 16);
      }
      ctx.restore();
    });
    ctx.restore();
  }

  function loop() {
    if (!ctx) return requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(now - lastTime, 32); 
    lastTime = now;
    ctx.clearRect(0, 0, canvasW, canvasH);
    const activeIds = new Set();
    
    markers.forEach(m => {
      activeIds.add(m.id);
      let v = state.get(m.id);
      if (!v) {
        v = { 
            id: m.id, op: 0, 
            x: { current: m.x, vel: 0, lastTarget: m.x },
            y: { current: m.y, vel: 0, lastTarget: m.y },
            w: { current: m.width || 0.1, vel: 0, lastTarget: m.width || 0.1 },
            h: { current: m.height || 0.1, vel: 0, lastTarget: m.height || 0.1 },
            dist: { current: m.distance || 0, vel: 0, lastTarget: m.distance || 0 }
        };
        state.set(m.id, v);
      }
      v.targetX = m.x; v.targetY = m.y; v.targetW = m.width || 0.1; v.targetH = m.height || 0.1;
      v.targetDist = m.distance || 0;
      v.label = m.label; v.source = m.source; v.speed = m.speed || 0;
      v.activity = m.activity; v.color = m.color; v.keypoints = m.keypoints; v.active = true;
    });

    state.forEach((v, id) => {
        if (!activeIds.has(id)) v.active = false;
        updateSecondOrder(v.x, v.targetX, dt);
        updateSecondOrder(v.y, v.targetY, dt);
        updateSecondOrder(v.w, v.targetW, dt);
        updateSecondOrder(v.h, v.targetH, dt);
        updateSecondOrder(v.dist, v.targetDist, dt);
        if (v.op < 0.01 && !v.active) state.delete(id);
    });

    if (xr) {
        renderView(0, 0, canvasW/2, canvasH, -15);
        renderView(canvasW/2, 0, canvasW/2, canvasH, 15);
    } else {
        renderView(0, 0, canvasW, canvasH, 0);
    }
    requestAnimationFrame(loop);
  }
`;

const VideoHUD: React.FC<VideoHUDProps> = React.memo(({ markers, onVideoFrame, onAddManualMarker, localStream, zoomLevel = 1, visualMode = 'normal', xrMode = false }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const detectionService = useRef<ObjectDetectionService | null>(null);
  const sensors = useRef({ a: 0, b: 0, anchorA: 0, anchorB: 0, init: false });

  useEffect(() => {
    if (!canvasRef.current) return;
    const worker = new Worker(URL.createObjectURL(new Blob([RENDER_WORKER_CODE], { type: 'application/javascript' })));
    const offscreen = canvasRef.current.transferControlToOffscreen();
    worker.postMessage({ type: 'INIT', payload: { canvas: offscreen } }, [offscreen]);
    workerRef.current = worker;
    detectionService.current = new ObjectDetectionService();
    detectionService.current.load();

    const handleOri = (e: DeviceOrientationEvent) => {
      const alpha = e.alpha || 0;
      const beta = e.beta || 0;
      if (!sensors.current.init && e.alpha !== null) {
          sensors.current.anchorA = alpha; sensors.current.anchorB = beta;
          sensors.current.init = true;
      }
      sensors.current.a = alpha; sensors.current.b = beta;
      workerRef.current?.postMessage({ type: 'UPDATE_SENSORS', payload: { ori: { alpha, beta }, zoom: zoomLevel } });
    };
    window.addEventListener('deviceorientation', handleOri, true);
    return () => { 
      worker.terminate(); 
      window.removeEventListener('deviceorientation', handleOri); 
      detectionService.current?.dispose(); 
    };
  }, [zoomLevel]);

  const handleHUDClick = useCallback((e: React.MouseEvent | React.TouchEvent) => {
      if (!onAddManualMarker || xrMode) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const clientX = 'touches' in e ? (e as React.TouchEvent).touches[0].clientX : (e as React.MouseEvent).clientX;
      const clientY = 'touches' in e ? (e as React.TouchEvent).touches[0].clientY : (e as React.MouseEvent).clientY;
      const nx = (clientX - rect.left) / rect.width;
      const ny = (clientY - rect.top) / rect.height;
      const currentFOV = 60 / zoomLevel;
      let da = sensors.current.a - sensors.current.anchorA;
      while (da > 180) da -= 360; while (da < -180) da += 360;
      let db = sensors.current.b - sensors.current.anchorB;
      const worldOffsetX = da / currentFOV;
      const worldOffsetY = db / (currentFOV * (rect.height/rect.width));
      onAddManualMarker(nx + worldOffsetX, ny + worldOffsetY);
  }, [onAddManualMarker, xrMode, zoomLevel]);

  useEffect(() => { 
    workerRef.current?.postMessage({ type: 'UPDATE_MODE', payload: { mode: visualMode, xr: xrMode } }); 
  }, [visualMode, xrMode]);
  
  useEffect(() => { if (videoRef.current && localStream) videoRef.current.srcObject = localStream; }, [localStream]);

  useEffect(() => {
    let frameId: number, lastFrameTime = 0;
    const process = async (time: number) => {
      if (videoRef.current?.readyState >= 2 && detectionService.current) {
        const local = await detectionService.current.detect(videoRef.current, { a: sensors.current.a, b: sensors.current.b }) || [];
        workerRef.current?.postMessage({ type: 'UPDATE_MARKERS', payload: [...local, ...markers] });

        if (time - lastFrameTime > 1200) { 
          const c = document.createElement('canvas'); c.width = 480; c.height = 270;
          const ctx = c.getContext('2d');
          if (ctx) {
            ctx.drawImage(videoRef.current, 0, 0, c.width, c.height);
            onVideoFrame(c.toDataURL('image/jpeg', 0.5).split(',')[1]);
            lastFrameTime = time;
          }
        }
      }
      frameId = requestAnimationFrame(process);
    };
    frameId = requestAnimationFrame(process);
    return () => cancelAnimationFrame(frameId);
  }, [onVideoFrame, markers]);

  const getFilterStyle = () => {
    switch (visualMode) {
      case 'thermal': return 'contrast(1.5) brightness(1.2) hue-rotate(180deg) invert(1) grayscale(0.5) saturate(2)';
      case 'night': return 'brightness(1.5) sepia(1) hue-rotate(70deg) saturate(3)';
      case 'machine': return 'brightness(1.1) contrast(1.2) saturate(0.5) sepia(0.2) hue-rotate(150deg)';
      default: return 'none';
    }
  };

  return (
    <div ref={containerRef} className={`absolute inset-0 w-full h-full overflow-hidden bg-black ${xrMode ? '' : 'cursor-crosshair'}`} onClick={handleHUDClick}>
      {xrMode ? (
          <div className="flex w-full h-full">
              <div className="w-1/2 h-full overflow-hidden border-r border-white/10">
                <video autoPlay playsInline muted className="w-full h-full object-cover transition-all" style={{ transform: `scale(${zoomLevel})`, filter: getFilterStyle() }} onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).srcObject = localStream; }} />
              </div>
              <div className="w-1/2 h-full overflow-hidden">
                <video autoPlay playsInline muted className="w-full h-full object-cover transition-all" style={{ transform: `scale(${zoomLevel})`, filter: getFilterStyle() }} onLoadedMetadata={(e) => { (e.target as HTMLVideoElement).srcObject = localStream; }} />
              </div>
          </div>
      ) : (
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover transition-all" style={{ transform: `scale(${zoomLevel})`, filter: getFilterStyle() }} />
      )}
      <canvas ref={canvasRef} width={window.innerWidth} height={window.innerHeight} className="absolute inset-0 w-full h-full pointer-events-none z-10" />
      <div className={`absolute inset-0 pointer-events-none z-20 mix-blend-overlay transition-opacity duration-500 ${
        visualMode === 'thermal' ? 'bg-indigo-900/40 opacity-80' : visualMode === 'night' ? 'bg-green-500/10 opacity-50' : 'opacity-0'
      }`} />
      {(visualMode === 'thermal' || visualMode === 'night') && (
        <div className="absolute inset-0 pointer-events-none z-20 opacity-20 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] mix-blend-screen" />
      )}
    </div>
  );
});

export default VideoHUD;
