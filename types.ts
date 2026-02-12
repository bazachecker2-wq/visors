
export interface Player {
  id: string;
  name: string;
  peerId?: string;
  lastSeen: number;
  location?: {
    lat: number;
    lng: number;
    heading?: number;
    accuracy?: number;
  };
  audioEnabled: boolean;
  markersCount: number;
}

export interface Keypoint {
  x: number;
  y: number;
  score?: number;
  name?: string;
}

export interface Marker {
  id: string;
  label: string;
  activity?: string;
  x: number; 
  y: number; 
  width?: number;
  height?: number;
  shape?: 'box' | 'point' | 'skeleton' | 'face_mesh';
  color?: string;
  distance?: number;
  source?: 'local' | 'ai' | 'manual';
  confidence?: number;
  keypoints?: Keypoint[];
  contours?: Record<string, { x: number; y: number }[]>;
  detailLevel?: number;
  lastUpdated?: number;
  velocity?: { x: number; y: number; z: number };
  acceleration?: number;
  speed?: number; 
  predictedX?: number;
  predictedY?: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

export enum ConnectionStatus {
  DISCONNECTED = 'ОТКЛЮЧЕНО',
  CONNECTING = 'ПОДКЛЮЧЕНИЕ',
  CONNECTED = 'АКТИВНО',
  ERROR = 'ОШИБКА',
}

export interface CameraCommand {
  type: 'zoom' | 'filter' | 'activity' | 'marker_add' | 'marker_mod' | 'marker_rem';
  value: any;
}
