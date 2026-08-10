export type ClientRole = 'sender' | 'receiver';

export type SignalPayload =
  | { kind: 'offer'; sdp: Record<string, unknown> }
  | { kind: 'answer'; sdp: Record<string, unknown> }
  | { kind: 'ice'; candidate: Record<string, unknown> };

export type ClientMessage =
  | { type: 'create-session'; role: ClientRole; publicKey: string }
  | { type: 'join-session'; code: string; role: ClientRole; publicKey: string }
  | { type: 'join-session-id'; sessionId: string; role: ClientRole; publicKey: string }
  | { type: 'signal'; payload: SignalPayload }
  | { type: 'ping' };

export type ServerMessage =
  | {
      type: 'session-created';
      sessionId: string;
      code: string;
      expiresAt: number;
    }
  | {
      type: 'session-joined';
      sessionId: string;
      peerPublicKey: string;
      peerRole: ClientRole;
    }
  | {
      type: 'peer-joined';
      peerPublicKey: string;
      peerRole: ClientRole;
    }
  | { type: 'signal'; payload: SignalPayload }
  | { type: 'peer-left' }
  | { type: 'error'; message: string }
  | { type: 'pong' };

export interface SessionPeer {
  id: string;
  role: ClientRole;
  publicKey: string;
  ws: import('ws').WebSocket;
}

export interface Session {
  id: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  peers: Map<string, SessionPeer>;
  failedJoinAttempts: number;
}
