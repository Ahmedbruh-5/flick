import type { ClientMessage, ClientRole, ServerMessage, SignalPayload } from './types';

export type SignalingHandlers = {
  onSessionCreated?: (data: {
    sessionId: string;
    code: string;
    expiresAt: number;
  }) => void;
  onSessionJoined?: (data: {
    sessionId: string;
    peerPublicKey: string;
    peerRole: ClientRole;
  }) => void;
  onPeerJoined?: (data: { peerPublicKey: string; peerRole: ClientRole }) => void;
  onSignal?: (payload: SignalPayload) => void;
  onPeerLeft?: () => void;
  onError?: (message: string) => void;
  onClose?: () => void;
};

const CONNECT_TIMEOUT_MS = 10_000;

function defaultWsUrl(): string {
  const override = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (override) return override;

  // Same origin as the page (Vite proxies /ws → signaling server).
  // Works for https://192.168.x.x:5173 on phones without opening port 8787.
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers: SignalingHandlers;

  constructor(handlers: SignalingHandlers = {}) {
    this.handlers = handlers;
  }

  connect(url = defaultWsUrl()): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;

      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(
          new Error(
            'Timed out connecting to signaling. Check that both devices use the HTTPS URL from your Mac.',
          ),
        );
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };

      ws.onerror = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(
          new Error(
            'Could not reach signaling server. Open the Network HTTPS URL from Vite on both devices.',
          ),
        );
      };

      ws.onclose = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error('Signaling connection closed before it opened'));
        }
        this.handlers.onClose?.();
      };

      ws.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          this.handlers.onError?.('Bad server message');
          return;
        }
        this.dispatch(message);
      };
    });
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case 'session-created':
        this.handlers.onSessionCreated?.(message);
        break;
      case 'session-joined':
        this.handlers.onSessionJoined?.(message);
        break;
      case 'peer-joined':
        this.handlers.onPeerJoined?.(message);
        break;
      case 'signal':
        this.handlers.onSignal?.(message.payload);
        break;
      case 'peer-left':
        this.handlers.onPeerLeft?.();
        break;
      case 'error':
        this.handlers.onError?.(message.message);
        break;
      default:
        break;
    }
  }

  private send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Signaling socket is not open');
    }
    this.ws.send(JSON.stringify(message));
  }

  createSession(role: ClientRole, publicKey: string): void {
    this.send({ type: 'create-session', role, publicKey });
  }

  joinByCode(code: string, role: ClientRole, publicKey: string): void {
    this.send({ type: 'join-session', code, role, publicKey });
  }

  joinBySessionId(sessionId: string, role: ClientRole, publicKey: string): void {
    this.send({ type: 'join-session-id', sessionId, role, publicKey });
  }

  signal(payload: SignalPayload): void {
    this.send({ type: 'signal', payload });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
