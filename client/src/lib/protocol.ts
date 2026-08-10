import { hashBytes } from './crypto';

/** Wire message types over the data channel */
export const MSG = {
  FILE_META: 1,
  CHUNK: 2,
  ACK: 3,
  NACK: 4,
  COMPLETE: 5,
  ERROR: 6,
} as const;

/**
 * CHUNK binary layout (big-endian):
 * [0]       type = 2
 * [1..4]    chunkIndex u32
 * [5..8]    totalChunks u32
 * [9..12]   plaintextLength u32
 * [13..44]  sha256(plaintext) 32 bytes
 * [45..56]  iv 12 bytes
 * [57..]    ciphertext (AES-GCM, includes 16-byte tag)
 */
export function encodeChunkMessage(opts: {
  chunkIndex: number;
  totalChunks: number;
  plaintextLength: number;
  plaintextHash: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}): ArrayBuffer {
  const headerSize = 57;
  const buffer = new ArrayBuffer(headerSize + opts.ciphertext.byteLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, MSG.CHUNK);
  view.setUint32(1, opts.chunkIndex, false);
  view.setUint32(5, opts.totalChunks, false);
  view.setUint32(9, opts.plaintextLength, false);
  bytes.set(opts.plaintextHash, 13);
  bytes.set(opts.iv, 45);
  bytes.set(opts.ciphertext, 57);

  return buffer;
}

export function decodeChunkMessage(buffer: ArrayBuffer): {
  chunkIndex: number;
  totalChunks: number;
  plaintextLength: number;
  plaintextHash: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
} | null {
  if (buffer.byteLength < 57) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== MSG.CHUNK) return null;

  const bytes = new Uint8Array(buffer);
  return {
    chunkIndex: view.getUint32(1, false),
    totalChunks: view.getUint32(5, false),
    plaintextLength: view.getUint32(9, false),
    plaintextHash: bytes.slice(13, 45),
    iv: bytes.slice(45, 57),
    ciphertext: bytes.slice(57),
  };
}

export function encodeJsonMessage(type: number, payload: unknown): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const buffer = new ArrayBuffer(1 + json.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes[0] = type;
  bytes.set(json, 1);
  return buffer;
}

export function decodeJsonMessage<T>(buffer: ArrayBuffer): { type: number; payload: T } | null {
  if (buffer.byteLength < 2) return null;
  const bytes = new Uint8Array(buffer);
  const type = bytes[0];
  try {
    const payload = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as T;
    return { type, payload };
  } catch {
    return null;
  }
}

export async function sha256Raw(data: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return new Uint8Array(digest);
}

export function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export { hashBytes };
