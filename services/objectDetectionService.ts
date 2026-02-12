
import { Marker, Keypoint } from '../types';

const WORKER_CODE = `
  const scripts = [
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/face-landmarks-detection@0.0.3/dist/face-landmarks-detection.js'
  ];

  try {
    scripts.forEach(s => importScripts(s));
  } catch (e) {
    console.error("Worker Script Loading Error", e);
  }

  const TRANSLATIONS = {
    'person': 'ЧЕЛОВЕК', 'bicycle': 'ВЕЛОСИПЕД', 'car': 'АВТО', 'motorcycle': 'МОТОЦИКЛ',
    'bus': 'АВТОБУС', 'truck': 'ГРУЗОВИК', 'backpack': 'РЮКЗАК', 'handbag': 'СУМКА',
    'cell phone': 'ТЕЛЕФОН', 'laptop': 'НОУТБУК', 'mouse': 'МЫШЬ', 'keyboard': 'КЛАВИАТУРА',
    'bottle': 'БУТЫЛКА', 'cup': 'ЧАШКА', 'chair': 'СТУЛ', 'table': 'СТОЛ', 'tv': 'ЭКРАН',
    'dog': 'СОБАКА', 'cat': 'КОШКА'
  };

  let objectModel = null, poseDetector = null, faceModel = null, isLoaded = false;

  const init = async () => {
    try {
      tf.env().set('WEBGL_PACK', false);
      await tf.setBackend('webgl');
      [faceModel, objectModel, poseDetector] = await Promise.all([
        faceLandmarksDetection.load(faceLandmarksDetection.SupportedPackages.mediapipeFacemesh, { maxFaces: 1 }),
        cocoSsd.load({ base: 'lite_mobilenet_v2' }),
        poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING })
      ]);
      isLoaded = true;
      postMessage({ type: 'LOADED' });
    } catch (e) { postMessage({ type: 'ERROR', message: e.message }); }
  };
  init();

  onmessage = async (e) => {
    if (!isLoaded || !e.data.imageBitmap) return;
    const { imageBitmap, orientation } = e.data;
    const w = imageBitmap.width, h = imageBitmap.height;
    tf.engine().startScope();
    try {
      const pixels = tf.browser.fromPixels(imageBitmap);
      const detections = [];
      const tasks = [];

      if (faceModel) tasks.push(faceModel.estimateFaces({ input: pixels }).then(faces => {
        faces.forEach(f => {
          detections.push({ 
            label: 'БИО_ЛИЦО', shape: 'face_mesh',
            x: (f.boundingBox.topLeft[0] + (f.boundingBox.bottomRight[0] - f.boundingBox.topLeft[0])/2)/w,
            y: (f.boundingBox.topLeft[1] + (f.boundingBox.bottomRight[1] - f.boundingBox.topLeft[1])/2)/h,
            width: (f.boundingBox.bottomRight[0] - f.boundingBox.topLeft[0])/w,
            height: (f.boundingBox.bottomRight[1] - f.boundingBox.topLeft[1])/h,
            confidence: 0.95 
          });
        });
      }));

      if (poseDetector) tasks.push(poseDetector.estimatePoses(pixels).then(poses => {
        poses.forEach(p => {
          if (p.score > 0.5) {
            const xs = p.keypoints.filter(k => k.score > 0.3).map(k => k.x);
            const ys = p.keypoints.filter(k => k.score > 0.3).map(k => k.y);
            if (xs.length > 0) {
              detections.push({ 
                label: 'ГУМАНОИД', shape: 'skeleton',
                x: (Math.min(...xs) + (Math.max(...xs)-Math.min(...xs))/2)/w,
                y: (Math.min(...ys) + (Math.max(...ys)-Math.min(...ys))/2)/h,
                width: (Math.max(...xs)-Math.min(...xs))/w, height: (Math.max(...ys)-Math.min(...ys))/h,
                keypoints: p.keypoints.map(k => ({ ...k, x: k.x/w, y: k.y/h })),
                confidence: p.score 
              });
            }
          }
        });
      }));

      if (objectModel) tasks.push(objectModel.detect(pixels, 8, 0.4).then(preds => {
        preds.forEach(p => {
          if (p.class !== 'person') {
            detections.push({ 
              label: (TRANSLATIONS[p.class] || p.class).toUpperCase(), shape: 'box',
              x: (p.bbox[0] + p.bbox[2]/2)/w, y: (p.bbox[1] + p.bbox[3]/2)/h,
              width: p.bbox[2]/w, height: p.bbox[3]/h, confidence: p.score 
            });
          }
        });
      }));

      await Promise.all(tasks);
      postMessage({ type: 'RESULT', detections, orientation });
    } catch(err) { console.error(err); } finally { tf.engine().endScope(); imageBitmap.close(); }
  };
`;

interface PersistenceData {
  id: string;
  hits: number;
  misses: number;
  lastSeen: number;
  worldX: number;
  worldY: number;
  w: number;
  h: number;
  label: string;
  shape: string;
  distAvg: number[];
  keypoints?: Keypoint[];
  velocity: { x: number; y: number };
}

export class ObjectDetectionService {
  private worker: Worker | null = null;
  private isReady = false;
  private isBusy = false;
  private lastMarkers: Marker[] = [];
  private persistenceCache = new Map<string, PersistenceData>();
  private nextId = 0;
  private anchorOri: { a: number; b: number } | null = null;

  private readonly HEIGHTS: Record<string, number> = {
    'ГУМАНОИД': 1.72, 'АВТО': 1.45, 'ГРУЗОВИК': 3.4, 'ТЕЛЕФОН': 0.16, 'БИО_ЛИЦО': 0.23, 'НОУТБУК': 0.28
  };
  
  private readonly H_FOV = 60; 
  private readonly MAX_MISSING_MS = 1500;
  private readonly DISTANT_THRESHOLD = 10.0;
  private readonly EXTRAPOLATION_LIMIT = 5;

  public load() {
    this.worker = new Worker(URL.createObjectURL(new Blob([WORKER_CODE], { type: 'application/javascript' })));
    this.worker.onmessage = (e) => {
      if (e.data.type === 'LOADED') this.isReady = true;
      if (e.data.type === 'RESULT') { 
        this.lastMarkers = this.process(e.data.detections, e.data.orientation); 
        this.isBusy = false; 
      }
    };
  }

  public async detect(video: HTMLVideoElement, ori: { a: number; b: number }): Promise<Marker[]> {
    if (!this.isReady || this.isBusy) return this.lastMarkers;
    this.isBusy = true;
    try {
        const bmp = await createImageBitmap(video, { resizeWidth: 320, resizeQuality: 'low' }); 
        this.worker?.postMessage({ imageBitmap: bmp, orientation: { ...ori } }, [bmp]);
    } catch(e) { this.isBusy = false; }
    return this.lastMarkers;
  }

  private getAlphaDiff(a1: number, a2: number) {
    let diff = a1 - a2;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return diff;
  }

  private process(newDets: any[], captureOri: { a: number; b: number }): Marker[] {
    const now = Date.now();
    if (!this.anchorOri) this.anchorOri = { ...captureOri };

    const da = this.getAlphaDiff(captureOri.a, this.anchorOri.a);
    const db = captureOri.b - this.anchorOri.b;

    const worldOffsetX = da / this.H_FOV; 
    const worldOffsetY = db / (this.H_FOV * 0.5625); // 9/16 aspect ratio

    const currentWorldDets = newDets.map(d => ({
        ...d,
        wx: d.x + worldOffsetX,
        wy: d.y + worldOffsetY,
        keypoints: d.keypoints ? d.keypoints.map((k:any) => ({ 
            ...k, 
            x: k.x + worldOffsetX, 
            y: k.y + worldOffsetY 
        })) : null
    }));

    const matchedIdx = new Set<number>();
    
    for (const [id, data] of this.persistenceCache.entries()) {
      let bestMatchIdx = -1;
      let maxIoU = 0.05;

      const dt_sec = (now - data.lastSeen) / 1000;
      const predX = data.worldX + (data.velocity.x * dt_sec);
      const predY = data.worldY + (data.velocity.y * dt_sec);

      currentWorldDets.forEach((det, idx) => {
        if (matchedIdx.has(idx)) return;
        const iou = this.getIoU({ worldX: predX, worldY: predY, w: data.w, h: data.h }, 
                                { wx: det.wx, wy: det.wy, w: det.width, h: det.height });
        if (iou > maxIoU) { 
            maxIoU = iou; 
            bestMatchIdx = idx; 
        }
      });

      if (bestMatchIdx !== -1) {
        const det = currentWorldDets[bestMatchIdx];
        matchedIdx.add(bestMatchIdx);
        
        const dt = (now - data.lastSeen) / 1000;
        if (dt > 0.01) {
            const instVX = (det.wx - data.worldX) / dt;
            const instVY = (det.wy - data.worldY) / dt;
            data.velocity.x = data.velocity.x * 0.7 + instVX * 0.3;
            data.velocity.y = data.velocity.y * 0.7 + instVY * 0.3;
        }

        data.worldX = det.wx;
        data.worldY = det.wy;
        data.w = det.width;
        data.h = det.height;
        data.keypoints = det.keypoints;
        data.lastSeen = now;
        data.hits++;
        data.misses = 0;
        
        const realH = this.HEIGHTS[det.label] || 1.2;
        data.distAvg.push(realH / (data.h * 1.15));
        if (data.distAvg.length > 5) data.distAvg.shift();
      } else {
        const dt_miss = (now - data.lastSeen) / 1000;
        if (dt_miss < 1.0 && data.hits > 3 && data.misses < this.EXTRAPOLATION_LIMIT) {
            data.misses++;
            data.worldX += data.velocity.x * dt_miss;
            data.worldY += data.velocity.y * dt_miss;
            data.lastSeen = now; 
        }
      }
    }

    currentWorldDets.forEach((det, idx) => {
      if (matchedIdx.has(idx) || det.confidence < 0.4) return;
      const id = 'local-' + this.nextId++;
      this.persistenceCache.set(id, {
        id, hits: 1, misses: 0, lastSeen: now,
        worldX: det.wx, worldY: det.wy,
        w: det.width, h: det.height,
        label: det.label, shape: det.shape,
        keypoints: det.keypoints,
        distAvg: [ (this.HEIGHTS[det.label] || 1.2) / (det.height * 1.15) ],
        velocity: { x: 0, y: 0 }
      });
    });

    const markers: Marker[] = [];
    for (const [id, data] of this.persistenceCache.entries()) {
      const staleTime = (now - data.lastSeen);
      if (staleTime > this.MAX_MISSING_MS) {
        this.persistenceCache.delete(id); 
        continue;
      }
      const avgDist = data.distAvg.reduce((a, b) => a + b, 0) / data.distAvg.length;
      markers.push({
        id: data.id, label: data.label,
        x: data.worldX, y: data.worldY, width: data.w, height: data.h,
        shape: data.shape as any,
        keypoints: data.keypoints,
        distance: parseFloat(avgDist.toFixed(1)),
        lastUpdated: data.lastSeen,
        source: 'local',
        confidence: data.misses > 0 ? 0.4 : 0.9,
        speed: parseFloat((Math.sqrt(data.velocity.x**2 + data.velocity.y**2) * 60).toFixed(1))
      });
    }
    return markers;
  }

  private getIoU(a: {worldX: number, worldY: number, w: number, h: number}, 
                 b: {wx: number, wy: number, w: number, h: number}) {
    const x1 = Math.max(a.worldX - a.w/2, b.wx - b.w/2);
    const y1 = Math.max(a.worldY - a.h/2, b.wy - b.h/2);
    const x2 = Math.min(a.worldX + a.w/2, b.wx + b.w/2);
    const y2 = Math.min(a.worldY + a.h/2, b.wy + b.h/2);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = (a.w * a.h) + (b.w * b.h) - inter;
    return inter / (union || 0.0001);
  }

  public dispose() { this.worker?.terminate(); }
}
