
import Peer, { MediaConnection } from 'peerjs';

export class P2PService {
  private peer: Peer | null = null;
  public onIncomingCall: (call: MediaConnection) => void = () => {};
  public onPeerOpen: (id: string) => void = () => {};
  private reconnectTimeout: any = null;

  constructor() {}

  public init(username: string) {
    // Generate a semi-stable ID or let PeerJS generate one
    const cleanId = username.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() + '-' + Math.floor(Math.random()*1000);
    
    // Initialize Peer with debug level 1 to see errors but reduce noise
    this.peer = new Peer(cleanId, { debug: 1 });

    this.peer.on('open', (id) => {
      console.log('My Peer ID is: ' + id);
      this.onPeerOpen(id);
      if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    });

    this.peer.on('call', (call) => {
      console.log('Incoming P2P Call');
      this.onIncomingCall(call);
    });

    // FIX: Handle auto-reconnection when signaling server drops
    this.peer.on('disconnected', () => {
        console.log('PeerJS: Disconnected from server. Attempting reconnect...');
        this.attemptReconnect();
    });

    this.peer.on('error', (err) => {
        // Suppress common noisy errors or handle critical ones
        if (err.type === 'peer-unavailable') {
            // Peer gone, nothing to do
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type) || err.message.includes('Lost connection')) {
             console.log('PeerJS: Network/Socket Error. Retrying...');
             this.attemptReconnect();
        } else {
             console.error("PeerJS Error", err);
        }
    });
  }

  private attemptReconnect() {
      if (this.reconnectTimeout) return;
      
      this.reconnectTimeout = setTimeout(() => {
          this.reconnectTimeout = null;
          if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
             console.log('PeerJS: Executing Reconnect...');
             try {
                 this.peer.reconnect();
             } catch(e) { console.warn("Reconnect failed", e); }
          }
      }, 3000);
  }

  public callUser(peerId: string, localStream: MediaStream): MediaConnection | null {
    if (!this.peer || this.peer.disconnected) {
        console.warn("PeerJS: Cannot call, disconnected.");
        return null;
    }
    return this.peer.call(peerId, localStream);
  }

  public destroy() {
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.peer) {
        this.peer.destroy();
        this.peer = null;
    }
  }
}
