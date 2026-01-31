
import { Marker } from '../types';

// --- WORKER CODE AS STRING ---
const WORKER_CODE = `
  // Use specific versions to ensure compatibility between tfjs core and models
  importScripts('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js');
  importScripts('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.2/dist/coco-ssd.min.js');
  importScripts('https://cdn.jsdelivr.net/npm/@tensorflow-models/pose-detection@2.1.3/dist/pose-detection.min.js');
  importScripts('https://cdn.jsdelivr.net/npm/@tensorflow-models/face-landmarks-detection@0.0.3/dist/face-landmarks-detection.js');

  let objectModel = null;
  let poseDetector = null;
  let faceModel = null;
  
  let isLoaded = false;
  let isLoading = false;

  // Standard MediaPipe FaceMesh Topology Indices
  const FACE_TOPOLOGY = {
      lipsUpper: [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291],
      lipsLower: [146, 91, 181, 84, 17, 314, 405, 321, 375, 291],
      rightEye: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
      leftEye: [263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398],
      rightEyebrow: [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
      leftEyebrow: [336, 296, 334, 293, 300, 276, 283, 282, 295, 285],
      silhouette: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
      nose: [168, 6, 197, 195, 5, 4, 1, 19, 94, 2]
  };

  const initModels = async () => {
    if (isLoading || isLoaded) return;
    isLoading = true;

    try {
      // 1. TF Init
      postMessage({ type: 'PROGRESS', label: 'NEURAL_KERNEL', value: 0.1 });
      
      if (typeof tf === 'undefined') {
          throw new Error("TensorFlow JS failed to load via importScripts");
      }

      tf.env().set('WEBGL_PACK', false); 
      await tf.setBackend('webgl');
      await tf.ready();
      
      console.log("Worker: TF Backend Ready (" + tf.getBackend() + ")");
      postMessage({ type: 'PROGRESS', label: 'KERNEL_READY', value: 0.2 });

      // 2. PARALLEL LOADING
      // Start all model loads simultaneously
      
      const pFace = faceLandmarksDetection.load(
        faceLandmarksDetection.SupportedPackages.mediapipeFacemesh,
        { maxFaces: 1 }
      ).then(m => {
          faceModel = m;
          postMessage({ type: 'PROGRESS', label: 'FACE_MESH_OK', value: 0.5 });
      }).catch(e => console.error("FaceMesh Error:", e));

      const pCoco = cocoSsd.load({ base: 'lite_mobilenet_v2' })
      .then(m => {
          objectModel = m;
          postMessage({ type: 'PROGRESS', label: 'OBJ_DETECTOR_OK', value: 0.7 });
      }).catch(e => console.warn("COCO Error:", e));

      const pPose = poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet, 
          { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
      ).then(m => {
          poseDetector = m;
          postMessage({ type: 'PROGRESS', label: 'POSE_ESTIMATOR_OK', value: 0.9 });
      }).catch(e => console.error("Pose Error:", e));

      // Wait for all to finish (success or fail)
      await Promise.all([pFace, pCoco, pPose]);

      if (faceModel || objectModel || poseDetector) {
          isLoaded = true;
          postMessage({ type: 'PROGRESS', label: 'SYSTEM_READY', value: 1.0 });
          postMessage({ type: 'LOADED' });
      } else {
          throw new Error("No models loaded successfully");
      }
      
    } catch (e) {
      console.error("Worker Critical Error:", e);
      postMessage({ type: 'ERROR', message: e.message });
      setTimeout(() => { isLoading = false; initModels(); }, 5000);
    } finally {
      isLoading = false;
    }
  };

  initModels();

  onmessage = async (e) => {
    if (!isLoaded || !e.data.imageBitmap) {
        if (e.data.imageBitmap && typeof e.data.imageBitmap.close === 'function') {
            e.data.imageBitmap.close();
        }
        return;
    }
    
    const { imageBitmap } = e.data;
    const markers = [];
    const bmpWidth = imageBitmap.width;
    const bmpHeight = imageBitmap.height;

    tf.engine().startScope();

    try {
      const pixels = tf.browser.fromPixels(imageBitmap);

      // Execute detections in parallel if possible, or sequentially within engine scope
      // JS is single threaded but TFJS might optimize backend ops. 
      // We keep sequential awaiting here to manage scope cleanup easily, 
      // but logic inside could be Promise.all if independent.
      
      const promises = [];

      // 1. Face Mesh
      if (faceModel) {
          promises.push(faceModel.estimateFaces({ input: pixels }).then(faces => {
              if (faces.length > 0) {
                  const face = faces[0];
                  const mesh = face.scaledMesh; 
                  
                  const xs = mesh.map(p => p[0]);
                  const ys = mesh.map(p => p[1]);
                  const minX = Math.min(...xs);
                  const maxX = Math.max(...xs);
                  const minY = Math.min(...ys);
                  const maxY = Math.max(...ys);
                  
                  const lipTop = mesh[13];
                  const lipBot = mesh[14];
                  const mouthOpen = Math.abs(lipBot[1] - lipTop[1]);
                  const mouthHeight = maxY - minY;
                  const isTalking = (mouthOpen / mouthHeight) > 0.05;

                  const contours = {};
                  for (const [part, indices] of Object.entries(FACE_TOPOLOGY)) {
                      contours[part] = indices.map(i => ({ 
                          x: mesh[i][0] / bmpWidth, 
                          y: mesh[i][1] / bmpHeight 
                      }));
                  }

                  markers.push({
                      id: 'face-mesh-0',
                      label: isTalking ? 'РЕЧЬ' : 'ЛИЦО',
                      x: (minX + (maxX - minX) / 2) / bmpWidth,
                      y: (minY + (maxY - minY) / 2) / bmpHeight,
                      width: (maxX - minX) / bmpWidth,
                      height: (maxY - minY) / bmpHeight,
                      shape: 'face_mesh',
                      source: 'ai',
                      confidence: 0.99,
                      contours: contours,
                      distance: 0.5 
                  });
              }
          }));
      }

      // 2. Pose
      if (poseDetector) {
        promises.push(poseDetector.estimatePoses(pixels, { flipHorizontal: false, maxPoses: 1 }).then(poses => {
            poses.forEach((pose, idx) => {
               if (pose.score > 0.35) { 
                 const xs = pose.keypoints.map(k => k.x);
                 const ys = pose.keypoints.map(k => k.y);
                 const minX = Math.min(...xs);
                 const maxX = Math.max(...xs);
                 const minY = Math.min(...ys);
                 const maxY = Math.max(...ys);
                 
                 markers.push({
                   id: 'pose-' + idx,
                   label: 'ТЕЛО',
                   x: (minX + (maxX - minX) / 2) / bmpWidth,
                   y: (minY + (maxY - minY) / 2) / bmpHeight,
                   width: (maxX - minX) / bmpWidth,
                   height: (maxY - minY) / bmpHeight,
                   shape: 'skeleton',
                   source: 'local',
                   confidence: pose.score,
                   keypoints: pose.keypoints.map(k => ({
                       ...k,
                       x: k.x / bmpWidth,
                       y: k.y / bmpHeight
                   })),
                   distance: 0 
                 });
               }
            });
        }));
      }

      // 3. Objects
      if (objectModel) {
          promises.push(objectModel.detect(pixels, undefined, 0.35).then(predictions => {
              predictions.forEach((p, idx) => {
                  if (p.class === 'person') return; 
                  if (p.bbox[2] * p.bbox[3] < 100) return;

                  markers.push({
                     id: 'obj-' + p.class + '-' + idx,
                     label: p.class,
                     x: (p.bbox[0] + p.bbox[2] / 2) / bmpWidth,
                     y: (p.bbox[1] + p.bbox[3] / 2) / bmpHeight,
                     width: p.bbox[2] / bmpWidth,
                     height: p.bbox[3] / bmpHeight,
                     shape: 'box',
                     source: 'local',
                     confidence: p.score
                  });
              });
          }));
      }

      await Promise.all(promises);
      postMessage({ type: 'RESULT', markers, timestamp: Date.now() });
      
    } catch (err) {
      console.error("Worker Runtime Error", err);
    } finally {
      tf.engine().endScope();
      if (typeof imageBitmap.close === 'function') imageBitmap.close();
    }
  };
`;

export class ObjectDetectionService {
  private worker: Worker | null = null;
  private isReady = false;
  private isBusy = false; 
  private lastProcessedTime = 0;
  private lastMarkers: Marker[] = [];

  private currentVideoWidth = 1;
  private currentVideoHeight = 1;
  
  public onProgress: (label: string, value: number) => void = () => {};

  public load() {
    if (this.worker) return;

    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));

    this.worker.onmessage = (e) => {
      if (e.data.type === 'LOADED') {
        this.isReady = true;
        console.log("Detection Service Ready");
      } else if (e.data.type === 'PROGRESS') {
        this.onProgress(e.data.label, e.data.value);
      } else if (e.data.type === 'RESULT') {
        this.lastMarkers = this.processRawMarkers(e.data.markers);
        this.isBusy = false; 
      } else if (e.data.type === 'ERROR') {
        console.error("Worker reported error:", e.data.message);
        this.isBusy = false;
      }
    };
    
    // Safety watchdog
    setInterval(() => { this.isBusy = false; }, 4000);
  }

  public dispose() {
    if (this.worker) {
        this.worker.terminate();
        this.worker = null;
    }
    this.isReady = false;
  }

  public async detect(video: HTMLVideoElement): Promise<Marker[]> {
    if (!this.worker) return this.lastMarkers;

    const now = Date.now();
    if (now - this.lastProcessedTime < 60) return this.lastMarkers;

    if (!this.isBusy) {
        try {
            this.isBusy = true;
            this.lastProcessedTime = now;
            this.currentVideoWidth = video.videoWidth;
            this.currentVideoHeight = video.videoHeight;
            
            const imageBitmap = await createImageBitmap(video, { 
                resizeWidth: 640, 
                resizeQuality: 'medium' 
            });

            this.worker.postMessage({ 
                imageBitmap, 
                originalWidth: this.currentVideoWidth,
                originalHeight: this.currentVideoHeight
            }, [imageBitmap]); 
        } catch (e) {
            this.isBusy = false;
        }
    }

    return this.lastMarkers;
  }

  private processRawMarkers(normalizedMarkers: Marker[]): Marker[] {
    return normalizedMarkers.map(m => ({
        ...m,
        label: this.translateLabel(m.label),
        x: m.x * this.currentVideoWidth,
        y: m.y * this.currentVideoHeight,
        width: (m.width || 0) * this.currentVideoWidth,
        height: (m.height || 0) * this.currentVideoHeight,
        keypoints: m.keypoints?.map(k => ({
            ...k,
            x: k.x * this.currentVideoWidth,
            y: k.y * this.currentVideoHeight
        })),
        contours: m.contours ? this.processContours(m.contours) : undefined,
        distance: this.calculateDistance((m.height || 0) * this.currentVideoHeight) 
    }));
  }

  private processContours(rawContours: any): any {
      const processed: any = {};
      for(const [key, points] of Object.entries(rawContours)) {
          processed[key] = (points as any[]).map(p => ({
              x: p.x * this.currentVideoWidth,
              y: p.y * this.currentVideoHeight
          }));
      }
      return processed;
  }

  private calculateDistance(bboxHeightPixels: number): number {
      const normalizedHeight = (bboxHeightPixels / this.currentVideoHeight) * 720;
      const ratio = normalizedHeight / 720; 
      if (ratio <= 0) return 0;
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
