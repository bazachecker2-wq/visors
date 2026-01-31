
export interface Player {
  id: string;
  name: string;
  peerId?: string; // For WebRTC
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
  x: number; // Percentage 0-100 or pixels (center)
  y: number; // Percentage 0-100 or pixels (center)
  width?: number;
  height?: number;
  shape?: 'box' | 'point' | 'skeleton' | 'face_mesh';
  color?: string; // hex or tailwind class ref
  distance?: number;
  source?: 'local' | 'ai'; // 'local' = COCO/Pose, 'ai' = Gemini
  confidence?: number;
  keypoints?: Keypoint[]; // For skeletons
  contours?: Record<string, { x: number; y: number }[]>; // For face mesh
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

export interface DirectMessage extends ChatMessage {
  targetId: string;
}

export enum ConnectionStatus {
  DISCONNECTED = 'ОТКЛЮЧЕНО',
  CONNECTING = 'ПОДКЛЮЧЕНИЕ',
  CONNECTED = 'АКТИВНО',
  ERROR = 'ОШИБКА',
}

export interface AppConfig {
  geminiApiKey: string;
  pocketBaseUrl: string;
}

// Tool Call Structure
export interface ToolCallPayload {
  action: 'add' | 'remove' | 'clear' | 'update';
  markers?: Marker[];
}

export interface CameraCommand {
  type: 'zoom' | 'filter';
  value: number | string; // zoom level (1-3) or filter type ('all', 'person', 'vehicle')
}