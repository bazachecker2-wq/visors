
import { Player, ChatMessage } from '../types';

// DISABLED PER USER REQUEST
export class BackendService {
  constructor(url: string) {
      // no-op
  }

  public async init(): Promise<boolean> {
    console.log("PocketBase Disabled");
    return false;
  }

  public async joinGame(player: Player): Promise<string | null> {
    return null;
  }

  public async updatePresence(data: Partial<Player>) {
  }

  public async leaveGame() {
  }

  public subscribeToPlayers(onUpdate: (players: Player[]) => void): () => void {
    return () => {};
  }

  public async sendMessage(msg: ChatMessage) {
  }

  public subscribeToChat(onMessage: (msg: ChatMessage) => void): () => void {
    return () => {};
  }

  public async addMemory(text: string, source: 'user' | 'ai' | 'system', deviceId: string) {
  }
}
