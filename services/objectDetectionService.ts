
import { Marker } from '../types';

// --- WORKER CODE AS STRING ---
const WORKER_CODE = `
  importScripts(
    'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js',
    'https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js'
  );

  let objectModel = null;
  let poseDetector = null;
  let isLoaded = false;

  const initModels = async () => {
    try {
      await tf.ready();
      // Lite model is crucial for mobile performance
      const cocoPromise = cocoSsd.load({ base: 'lite_mobilenet_v2' });
      const detectorConfig = { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING };
      const posePromise = poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, detectorConfig);

      const [obj, pose] = await Promise.all([cocoPromise, posePromise]);
      objectModel = obj;
      poseDetector = pose;
      isLoaded = true;
      postMessage({ type: 'LOADED' });
    } catch (e) {
      console.error("Worker Model Load Error:", e);
    }
  };

  initModels();

  onmessage = async (e) => {
    if (!isLoaded || !e.data.imageBitmap) {
        if (e.data.imageBitmap) e.data.imageBitmap.close();
        return;
    }
    
    const { imageBitmap } = e.data;
    const markers = [];

    try {
      // 1. Pose Detection (Fastest)
      if (poseDetector) {
        const poses = await poseDetector.estimatePoses(imageBitmap, { 
            flipHorizontal: false,
            maxPoses: 1 // Strictly limit to 1 for mobile speed
        });
        
        poses.forEach((pose, idx) => {
           if (pose.score > 0.4) {
             const xs = pose.keypoints.map(k => k.x);
             const ys = pose.keypoints.map(k => k.y);
             const minX = Math.min(...xs);
             const maxX = Math.max(...xs);
             const minY = Math.min(...ys);
             const maxY = Math.max(...ys);
             
             markers.push({
               id: 'pose-' + idx,
               label: 'ЧЕЛОВЕК',
               x: minX + (maxX - minX) / 2,
               y: minY + (maxY - minY) / 2,
               width: maxX - minX,
               height: maxY - minY,
               shape: 'skeleton',
               source: 'local',
               confidence: pose.score,
               keypoints: pose.keypoints,
               distance: 0 
             });
           }
        });
      }

      // 2. Object Detection (Slower, run after Pose)
      if (objectModel) {
        const predictions = await objectModel.detect(imageBitmap, undefined, 0.4);
        predictions.forEach((p, idx) => {
          if (p.class === 'person') return; // Handled by pose
          markers.push({
             id: 'obj-' + p.class + '-' + idx,
             label: p.class,
             x: p.bbox[0] + p.bbox[2] / 2,
             y: p.bbox[1] + p.bbox[3] / 2,
             width: p.bbox[2],
             height: p.bbox[3],
             shape: 'box',
             source: 'local',
             confidence: p.score
          });
        });
      }

      postMessage({ type: 'RESULT', markers, timestamp: Date.now() });
    } catch (err) {
      console.error(err);
    } finally {
      // CRITICAL: Close bitmap to prevent GPU memory leak on mobile
      imageBitmap.close(); 
    }
  };
`;

export class ObjectDetectionService {
  private worker: Worker | null = null;
  private isReady = false;
  private isBusy = false; 
  private lastProcessedTime = 0;
  
  // Interpolation State
  private targetMarkers: Map<string, Marker> = new Map();
  private currentMarkers: Map<string, Marker> = new Map();
  private persistenceMap: Map<string, number> = new Map(); 
  
  private readonly MAX_PERSISTENCE = 10;
  
  // Stabilization Constants
  private readonly JITTER_THRESHOLD = 3.0; // Pixels to ignore (Deadzone)
  private readonly MIN_LERP = 0.08; // Very smooth for slow movement
  private readonly MAX_LERP = 0.6;  // Fast snap for large movement

  public load() {
    if (this.worker) return;

    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));

    this.worker.onmessage = (e) => {
      if (e.data.type === 'LOADED') {
        this.isReady = true;
        console.log("VisionOS: Detection Worker Online");
      } else if (e.data.type === 'RESULT') {
        this.processWorkerResults(e.data.markers);
        this.isBusy = false; // Mark worker as free
      }
    };
    
    // Safety watchdog
    setInterval(() => { this.isBusy = false; }, 3000);
  }

  public async detect(video: HTMLVideoElement): Promise<Marker[]> {
    if (!this.isReady || !this.worker) return this.getInterpolatedMarkers(video.videoHeight);

    // Flow Control:
    // 1. Worker must be free
    // 2. Video must have new data (currentTime check)
    if (!this.isBusy && video.currentTime !== this.lastProcessedTime) {
        try {
            this.isBusy = true;
            this.lastProcessedTime = video.currentTime;
            const imageBitmap = await createImageBitmap(video);
            this.worker.postMessage({ 
                imageBitmap, 
                width: video.videoWidth, 
                height: video.videoHeight 
            }, [imageBitmap]); // Transfer ownership
        } catch (e) {
            this.isBusy = false;
        }
    }

    // Always return interpolated positions for 60FPS fluidity
    return this.getInterpolatedMarkers(video.videoHeight);
  }

  private processWorkerResults(rawMarkers: Marker[]) {
    // Mark valid IDs from this batch
    const foundIds = new Set<string>();

    rawMarkers.forEach(raw => {
        raw.label = this.translateLabel(raw.label);
        foundIds.add(raw.id);
        
        // Update Target
        this.targetMarkers.set(raw.id, raw);
        // Reset Life
        this.persistenceMap.set(raw.id, this.MAX_PERSISTENCE);

        // Instant spawn for new objects
        if (!this.currentMarkers.has(raw.id)) {
            this.currentMarkers.set(raw.id, { ...raw });
        }
    });
  }

  private getInterpolatedMarkers(screenHeight: number): Marker[] {
    const output: Marker[] = [];
    const deadIds: string[] = [];

    this.currentMarkers.forEach((curr, id) => {
        const target = this.targetMarkers.get(id);
        let life = this.persistenceMap.get(id) || 0;

        // Kill logic
        if (life <= 0) {
            deadIds.push(id);
            return;
        }
        
        this.persistenceMap.set(id, life - 1);

        if (target) {
            // --- ADAPTIVE SMOOTHING LOGIC ---
            
            // Calculate Euclidean distance
            const dx = target.x - curr.x;
            const dy = target.y - curr.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // 1. Deadzone check: If movement is tiny (camera shake), do not move at all
            if (dist < this.JITTER_THRESHOLD) {
                // Keep current position, do nothing to x/y
            } else {
                // 2. Adaptive LERP Factor
                // Map distance to factor: 
                // Small move (10px) -> Factor ~0.1 (Smooth)
                // Large move (100px) -> Factor ~0.6 (Fast)
                let lerpFactor = (dist / 100) * this.MAX_LERP;
                lerpFactor = Math.max(this.MIN_LERP, Math.min(this.MAX_LERP, lerpFactor));

                curr.x += dx * lerpFactor;
                curr.y += dy * lerpFactor;
                
                // Also smooth dimensions
                curr.width = (curr.width || 0) + ((target.width || 0) - (curr.width || 0)) * lerpFactor;
                curr.height = (curr.height || 0) + ((target.height || 0) - (curr.height || 0)) * lerpFactor;
            }
            
            // Skeleton Interpolation (apply same logic or simpler)
            if (curr.keypoints && target.keypoints) {
                curr.keypoints = curr.keypoints.map((k, i) => {
                    const tk = target.keypoints![i];
                    if (!tk) return k;
                    
                    const kdx = tk.x - k.x;
                    const kdy = tk.y - k.y;
                    const kDist = Math.sqrt(kdx * kdx + kdy * kdy);
                    
                    if (kDist < this.JITTER_THRESHOLD) return k;

                    // Use slightly faster lerp for limbs as they move faster than body center
                    const limbFactor = Math.min(0.7, Math.max(0.2, kDist / 50));
                    
                    return {
                        ...k,
                        x: k.x + kdx * limbFactor,
                        y: k.y + kdy * limbFactor
                    };
                });
            }
            curr.distance = this.calculateDistance(curr.height || 100, screenHeight);
        }

        output.push(curr);
    });

    // Cleanup
    deadIds.forEach(id => {
        this.currentMarkers.delete(id);
        this.targetMarkers.delete(id);
        this.persistenceMap.delete(id);
    });

    return output;
  }

  private calculateDistance(bboxHeight: number, imageHeight: number): number {
      const ratio = bboxHeight / imageHeight;
      if (ratio <= 0) return 0;
      // Heuristic: Average human height / pixel height ratio
      const dist = 1.0 / ratio; 
      return parseFloat(dist.toFixed(1));
  }

  private translateLabel(englishLabel: string): string {
       const map: Record<string, string> = {
          'person': 'ЧЕЛОВЕК',
          'bicycle': 'ВЕЛО',
          'car': 'АВТО',
          'motorcycle': 'МОТО',
          'airplane': 'БПЛА',
          'bus': 'АВТОБУС',
          'train': 'ПОЕЗД',
          'truck': 'ГРУЗ',
          'boat': 'ЛОДКА',
          'traffic light': 'СВЕТОФОР',
          'stop sign': 'СТОП',
          'cat': 'КОТ',
          'dog': 'СОБАКА',
          'backpack': 'РЮКЗАК',
          'umbrella': 'ЗОНТ',
          'handbag': 'СУМКА',
          'suitcase': 'КЕЙС',
          'bottle': 'БУТЫЛКА',
          'knife': 'НОЖ',
          'laptop': 'ТЕРМИНАЛ',
          'cell phone': 'СМАРТФОН',
          'book': 'ДОКУМЕНТЫ',
      };
      return map[englishLabel] || englishLabel.toUpperCase();
  }
}
