import { randomInt } from 'node:crypto';
import type { Session } from './types.js';

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_FAILED_JOINS = 12;

const sessionsById = new Map<string, Session>();
const sessionsByCode = new Map<string, Session>();

function generateCode(): string {
  // 6 digits, avoid leading-zero ambiguity by always padding
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function uniqueCode(): string {
  for (let i = 0; i < 20; i++) {
    const code = generateCode();
    if (!sessionsByCode.has(code)) return code;
  }
  throw new Error('Could not allocate a unique pairing code');
}

export function createSession(sessionId: string): Session {
  const now = Date.now();
  const session: Session = {
    id: sessionId,
    code: uniqueCode(),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    peers: new Map(),
    failedJoinAttempts: 0,
  };
  sessionsById.set(session.id, session);
  sessionsByCode.set(session.code, session);
  return session;
}

export function getSessionById(sessionId: string): Session | undefined {
  const session = sessionsById.get(sessionId);
  if (!session) return undefined;
  if (Date.now() > session.expiresAt) {
    destroySession(session);
    return undefined;
  }
  return session;
}

export function getSessionByCode(code: string): Session | undefined {
  const normalized = code.trim();
  const session = sessionsByCode.get(normalized);
  if (!session) return undefined;
  if (Date.now() > session.expiresAt) {
    destroySession(session);
    return undefined;
  }
  return session;
}

export function recordFailedJoin(session: Session): boolean {
  session.failedJoinAttempts += 1;
  if (session.failedJoinAttempts >= MAX_FAILED_JOINS) {
    destroySession(session);
    return true;
  }
  return false;
}

export function destroySession(session: Session): void {
  sessionsById.delete(session.id);
  sessionsByCode.delete(session.code);
  for (const peer of session.peers.values()) {
    try {
      peer.ws.close();
    } catch {
      // ignore
    }
  }
  session.peers.clear();
}

export function removePeer(session: Session, peerId: string): void {
  session.peers.delete(peerId);
  if (session.peers.size === 0) {
    destroySession(session);
  }
}

export function pruneExpiredSessions(): void {
  const now = Date.now();
  for (const session of [...sessionsById.values()]) {
    if (now > session.expiresAt) destroySession(session);
  }
}
