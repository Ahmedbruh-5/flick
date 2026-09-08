import type { ConnectionType } from './types';

export type HistoryDirection = 'sent' | 'received';
export type HistoryStatus = 'done' | 'failed';

export interface HistoryEntry {
  id: string;
  direction: HistoryDirection;
  fileName: string;
  fileSize: number;
  status: HistoryStatus;
  connectionType: ConnectionType;
  error?: string;
  createdAt: number;
}

export type NewHistoryEntry = Omit<HistoryEntry, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: number;
};

const STORAGE_KEY = 'flick-transfer-history';
const MAX_ENTRIES = 100;

function readRaw(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isHistoryEntry);
  } catch {
    return [];
  }
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<HistoryEntry>;
  return (
    typeof e.id === 'string' &&
    (e.direction === 'sent' || e.direction === 'received') &&
    typeof e.fileName === 'string' &&
    typeof e.fileSize === 'number' &&
    (e.status === 'done' || e.status === 'failed') &&
    typeof e.createdAt === 'number'
  );
}

function writeRaw(entries: HistoryEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
}

export function listHistory(): HistoryEntry[] {
  return readRaw().sort((a, b) => b.createdAt - a.createdAt);
}

export function addHistoryEntry(input: NewHistoryEntry): HistoryEntry {
  const entry: HistoryEntry = {
    id: input.id ?? crypto.randomUUID(),
    direction: input.direction,
    fileName: input.fileName,
    fileSize: input.fileSize,
    status: input.status,
    connectionType: input.connectionType ?? 'unknown',
    error: input.error,
    createdAt: input.createdAt ?? Date.now(),
  };

  const next = [entry, ...readRaw().filter((e) => e.id !== entry.id)];
  writeRaw(next);
  return entry;
}

export function removeHistoryEntry(id: string) {
  writeRaw(readRaw().filter((e) => e.id !== id));
}

export function clearHistory() {
  localStorage.removeItem(STORAGE_KEY);
}

export function formatHistoryTime(createdAt: number): string {
  const date = new Date(createdAt);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  if (sameDay) return `Today · ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) return `Yesterday · ${time}`;

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
