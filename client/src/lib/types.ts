export type ClientRole = 'sender' | 'receiver';

export type ConnectionType = 'lan' | 'p2p' | 'relay' | 'unknown';

export type SignalPayload =
  | { kind: 'offer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'answer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit };

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

export interface PairingPayload {
  v: 1;
  sessionId: string;
  code: string;
  publicKey: string;
}

export interface FileMeta {
  type: 'file-meta';
  name: string;
  size: number;
  mime: string;
  chunkSize: number;
  totalChunks: number;
}

export interface TransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  speedBps: number;
  connectionType: ConnectionType;
  status: 'connecting' | 'transferring' | 'verifying' | 'done' | 'failed';
  error?: string;
  fileName?: string;
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const CHUNK_SIZE = 64 * 1024;
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
