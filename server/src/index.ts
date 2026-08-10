import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createSession,
  destroySession,
  getSessionByCode,
  getSessionById,
  pruneExpiredSessions,
  recordFailedJoin,
  removePeer,
} from './session.js';
import type { ClientMessage, ClientRole, ServerMessage, Session } from './types.js';

const PORT = Number(process.env.PORT ?? 8787);

const app = express();
app.use(cors());
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'flick-signaling' });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const peerSession = new WeakMap<WebSocket, { session: Session; peerId: string }>();

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastToPeers(
  session: Session,
  exceptPeerId: string,
  message: ServerMessage,
): void {
  for (const peer of session.peers.values()) {
    if (peer.id !== exceptPeerId) send(peer.ws, message);
  }
}

function roleTaken(session: Session, role: ClientRole): boolean {
  for (const peer of session.peers.values()) {
    if (peer.role === role) return true;
  }
  return false;
}

function attachPeer(
  ws: WebSocket,
  session: Session,
  role: ClientRole,
  publicKey: string,
): string | null {
  if (session.peers.size >= 2) {
    send(ws, { type: 'error', message: 'Session is full' });
    return null;
  }
  if (roleTaken(session, role)) {
    send(ws, { type: 'error', message: `A ${role} is already in this session` });
    return null;
  }

  const peerId = randomUUID();
  session.peers.set(peerId, { id: peerId, role, publicKey, ws });
  peerSession.set(ws, { session, peerId });
  return peerId;
}

function handleCreate(
  ws: WebSocket,
  role: ClientRole,
  publicKey: string,
): void {
  const session = createSession(randomUUID());
  const peerId = attachPeer(ws, session, role, publicKey);
  if (!peerId) {
    destroySession(session);
    return;
  }

  send(ws, {
    type: 'session-created',
    sessionId: session.id,
    code: session.code,
    expiresAt: session.expiresAt,
  });
}

function handleJoinByCode(
  ws: WebSocket,
  code: string,
  role: ClientRole,
  publicKey: string,
): void {
  const session = getSessionByCode(code);
  if (!session) {
    send(ws, { type: 'error', message: 'Invalid or expired code' });
    return;
  }

  if (session.peers.size >= 2 || roleTaken(session, role)) {
    const locked = recordFailedJoin(session);
    send(ws, {
      type: 'error',
      message: locked
        ? 'Too many failed attempts — session closed'
        : 'Unable to join this session',
    });
    return;
  }

  const existing = [...session.peers.values()][0];
  const peerId = attachPeer(ws, session, role, publicKey);
  if (!peerId || !existing) return;

  session.failedJoinAttempts = 0;

  send(ws, {
    type: 'session-joined',
    sessionId: session.id,
    peerPublicKey: existing.publicKey,
    peerRole: existing.role,
  });

  send(existing.ws, {
    type: 'peer-joined',
    peerPublicKey: publicKey,
    peerRole: role,
  });
}

function handleJoinById(
  ws: WebSocket,
  sessionId: string,
  role: ClientRole,
  publicKey: string,
): void {
  const session = getSessionById(sessionId);
  if (!session) {
    send(ws, { type: 'error', message: 'Invalid or expired session' });
    return;
  }

  const existing = [...session.peers.values()][0];
  const peerId = attachPeer(ws, session, role, publicKey);
  if (!peerId) return;

  if (existing) {
    send(ws, {
      type: 'session-joined',
      sessionId: session.id,
      peerPublicKey: existing.publicKey,
      peerRole: existing.role,
    });
    send(existing.ws, {
      type: 'peer-joined',
      peerPublicKey: publicKey,
      peerRole: role,
    });
  } else {
    send(ws, {
      type: 'session-created',
      sessionId: session.id,
      code: session.code,
      expiresAt: session.expiresAt,
    });
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (message.type) {
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      case 'create-session':
        handleCreate(ws, message.role, message.publicKey);
        break;
      case 'join-session':
        handleJoinByCode(ws, message.code, message.role, message.publicKey);
        break;
      case 'join-session-id':
        handleJoinById(ws, message.sessionId, message.role, message.publicKey);
        break;
      case 'signal': {
        const binding = peerSession.get(ws);
        if (!binding) {
          send(ws, { type: 'error', message: 'Not in a session' });
          return;
        }
        broadcastToPeers(binding.session, binding.peerId, {
          type: 'signal',
          payload: message.payload,
        });
        break;
      }
      default:
        send(ws, { type: 'error', message: 'Unknown message type' });
    }
  });

  ws.on('close', () => {
    const binding = peerSession.get(ws);
    if (!binding) return;
    const { session, peerId } = binding;
    removePeer(session, peerId);
    broadcastToPeers(session, peerId, { type: 'peer-left' });
  });
});

setInterval(pruneExpiredSessions, 30_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Flick signaling server on http://localhost:${PORT}`);
  console.log(`WebSocket path: ws://localhost:${PORT}/ws`);
});
