
import PocketBase, { RecordModel } from 'pocketbase';
import { Player, ChatMessage } from '../types';

export class BackendService {
  private pb: PocketBase;
  private myRecordId: string | null = null;
  
  constructor(url: string) {
    this.pb = new PocketBase(url);
    this.pb.autoCancellation(false);
  }

  public async init(): Promise<boolean> {
    try {
      // Basic URL validation
      try { new URL(this.pb.baseUrl); } catch { return false; }

      // Authenticate as the "Server/Admin" or shared account to ensure R/W access
      if (!this.pb.authStore.isValid) {
        await this.pb.collection('users').authWithPassword('bazachecker@gmail.com', 'Aibusu07');
        console.log("PocketBase: System Online");
      }
      return true;
    } catch (e: any) {
      // Handle known connection issues gracefully without spamming error logs
      const isMixedContent = e?.message?.includes('Failed to fetch') || e?.name === 'TypeError';
      if (isMixedContent) {
          console.warn(`PocketBase Connection Error: Check URL or Mixed Content (HTTP vs HTTPS). Target: ${this.pb.baseUrl}`);
      } else {
          console.warn("PocketBase Auth Failed:", e.message || e);
      }
      return false;
    }
  }

  // --- PLAYER PRESENCE ---

  public async joinGame(player: Player): Promise<string | null> {
    if (!this.pb.authStore.isValid) return null;

    try {
      // Create a record in 'active_players' collection
      // We store the data flattened
      const record = await this.pb.collection('active_players').create({
        session_id: player.id, // Our client-side ID
        name: player.name,
        peer_id: player.peerId,
        last_seen: new Date().toISOString(),
        audio_enabled: player.audioEnabled,
        markers_count: player.markersCount,
        status: 'online'
      });
      this.myRecordId = record.id;
      return record.id;
    } catch (e) {
      console.warn("Join Game Failed (Likely Duplicate or Auth)", e);
      return null;
    }
  }

  public async updatePresence(data: Partial<Player>) {
    if (!this.myRecordId || !this.pb.authStore.isValid) return;
    try {
      // Map frontend keys to DB keys if necessary, or pass clean object
      const payload: any = {
        last_seen: new Date().toISOString()
      };
      
      if (data.peerId) payload.peer_id = data.peerId;
      if (data.markersCount !== undefined) payload.markers_count = data.markersCount;
      if (data.name) payload.name = data.name;

      await this.pb.collection('active_players').update(this.myRecordId, payload);
    } catch (e) {
      // Silent fail on heartbeat to prevent log spam
    }
  }

  public async leaveGame() {
    if (!this.myRecordId || !this.pb.authStore.isValid) return;
    try {
      await this.pb.collection('active_players').delete(this.myRecordId);
      this.myRecordId = null;
    } catch (e) {
      // Record might already be deleted
    }
  }

  public subscribeToPlayers(onUpdate: (players: Player[]) => void): () => void {
    if (!this.pb.authStore.isValid) return () => {};

    // 1. Initial Fetch
    this.pb.collection('active_players').getFullList({ sort: '-created' })
      .then(records => onUpdate(records.map(this.mapRecordToPlayer)))
      .catch(e => console.warn("Fetch players failed", e));

    // 2. Subscribe
    let unsubscribeFunc: (() => void) | null = null;
    
    this.pb.collection('active_players').subscribe('*', async (e) => {
        // Fetch fresh list on any change to ensure consistency (simpler than merging diffs manually)
        try {
            const records = await this.pb.collection('active_players').getFullList({ sort: '-created' });
            onUpdate(records.map(this.mapRecordToPlayer));
        } catch(err) { /* ignore */ }
    }).then(unsub => { unsubscribeFunc = unsub; }).catch(e => console.warn("Subscribe failed", e));

    return () => {
      if (unsubscribeFunc) unsubscribeFunc();
    };
  }

  private mapRecordToPlayer(r: RecordModel): Player {
    return {
      id: r.session_id, // Map database session_id back to app id
      name: r.name,
      peerId: r.peer_id,
      lastSeen: new Date(r.last_seen).getTime(),
      audioEnabled: r.audio_enabled,
      markersCount: r.markers_count,
      location: undefined // Geolocation removed for simplicity/privacy in DB for now
    };
  }

  // --- CHAT ---

  public async sendMessage(msg: ChatMessage) {
    if (!this.pb.authStore.isValid) return;
    try {
      await this.pb.collection('messages').create({
        client_msg_id: msg.id,
        sender_id: msg.senderId,
        sender_name: msg.senderName,
        text: msg.text,
        target_id: (msg as any).targetId || '',
        timestamp: new Date(msg.timestamp).toISOString()
      });
    } catch (e) {
      console.error("Send Message Error:", e);
    }
  }

  public subscribeToChat(onMessage: (msg: ChatMessage) => void): () => void {
    if (!this.pb.authStore.isValid) return () => {};

    let unsubscribeFunc: (() => void) | null = null;

    this.pb.collection('messages').subscribe('*', (e) => {
      if (e.action === 'create') {
        onMessage({
          id: e.record.client_msg_id,
          senderId: e.record.sender_id,
          senderName: e.record.sender_name,
          text: e.record.text,
          timestamp: new Date(e.record.timestamp).getTime(),
          ...(e.record.target_id ? { targetId: e.record.target_id } : {})
        } as ChatMessage);
      }
    }).then(unsub => { unsubscribeFunc = unsub; }).catch(e => console.warn("Chat sub failed", e));

    return () => {
      if (unsubscribeFunc) unsubscribeFunc();
    };
  }

  // --- MEMORIES (AI LOGS) ---

  public async addMemory(text: string, source: 'user' | 'ai' | 'system', deviceId: string) {
    if (!this.pb.authStore.isValid) return;
    try {
      await this.pb.collection('memories').create({
        text,
        source,
        deviceId,
      });
    } catch (e) {
      // Silent fail
    }
  }
}
