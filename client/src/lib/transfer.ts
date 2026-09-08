import {
  createSha256Hasher,
  decryptChunk,
  encryptChunk,
  hashBlobStreaming,
} from './crypto';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  MSG,
  decodeChunkMessage,
  decodeJsonMessage,
  encodeChunkMessage,
  encodeJsonMessage,
  hashesEqual,
  sha256Raw,
} from './protocol';
import {
  CHUNK_SIZE,
  MAX_FILE_BYTES,
  type ConnectionType,
  type FileMeta,
  type TransferProgress,
} from './types';

const ACK_BATCH = 8;
const BUFFERED_AMOUNT_LOW = 256 * 1024;
const BUFFERED_AMOUNT_HIGH = 1024 * 1024;

export type ProgressCallback = (progress: TransferProgress) => void;

export class TransferCancelledError extends Error {
  constructor(message = 'Transfer cancelled') {
    super(message);
    this.name = 'TransferCancelledError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransferCancelledError();
}

function waitForChannelOpen(
  channel: RTCDataChannel,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Data channel failed'));
    };
    const onAbort = () => {
      cleanup();
      reject(new TransferCancelledError());
    };
    const cleanup = () => {
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForBufferLow(
  channel: RTCDataChannel,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (channel.bufferedAmount < BUFFERED_AMOUNT_LOW) return Promise.resolve();
  return new Promise((resolve, reject) => {
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new TransferCancelledError());
    };
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      signal?.removeEventListener('abort', onAbort);
    };
    channel.addEventListener('bufferedamountlow', onLow);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new TransferCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class SpeedTracker {
  private samples: { t: number; bytes: number }[] = [];

  push(bytesTransferred: number): number {
    const now = performance.now();
    this.samples.push({ t: now, bytes: bytesTransferred });
    while (this.samples.length > 1 && now - this.samples[0]!.t > 1000) {
      this.samples.shift();
    }
    if (this.samples.length < 2) return 0;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return (last.bytes - first.bytes) / dt;
  }
}

export async function sendFile(opts: {
  channel: RTCDataChannel;
  file: File;
  sessionKey: CryptoKey;
  connectionType: ConnectionType;
  onProgress: ProgressCallback;
  signal?: AbortSignal;
}): Promise<void> {
  const { channel, file, sessionKey, onProgress, signal } = opts;

  if (file.size > MAX_FILE_BYTES) {
    throw new Error('File exceeds the 2 GB MVP limit');
  }

  await waitForChannelOpen(channel, signal);

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const meta: FileMeta = {
    type: 'file-meta',
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream',
    chunkSize: CHUNK_SIZE,
    totalChunks,
  };

  channel.send(encodeJsonMessage(MSG.FILE_META, meta));

  const acked = new Set<number>();
  let remoteError: string | null = null;
  const speed = new SpeedTracker();

  const onMessage = (event: MessageEvent) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const decoded = decodeJsonMessage<{
      type?: string;
      chunkIndex?: number;
      indices?: number[];
      message?: string;
      fileHash?: string;
    }>(event.data);
    if (!decoded) return;

    if (decoded.type === MSG.ACK) {
      const indices = decoded.payload.indices ?? [];
      for (const i of indices) acked.add(i);
      if (typeof decoded.payload.chunkIndex === 'number') {
        acked.add(decoded.payload.chunkIndex);
      }
    } else if (decoded.type === MSG.NACK) {
      // Sender will naturally retransmit unacked chunks on resume paths later;
      // for MVP we surface failure if a nack arrives mid-stream.
      remoteError = `Chunk ${decoded.payload.chunkIndex ?? '?'} failed integrity check`;
    } else if (decoded.type === MSG.ERROR) {
      remoteError = decoded.payload.message ?? 'Receiver error';
    }
  };

  channel.addEventListener('message', onMessage);

  try {
    let nextToSend = 0;
    const inFlight = new Set<number>();

    while (acked.size < totalChunks) {
      throwIfAborted(signal);
      if (remoteError) throw new Error(remoteError);
      if (channel.readyState !== 'open') throw new Error('Connection lost');

      while (
        nextToSend < totalChunks &&
        inFlight.size < ACK_BATCH * 2 &&
        channel.bufferedAmount < BUFFERED_AMOUNT_HIGH
      ) {
        const chunkIndex = nextToSend++;
        if (acked.has(chunkIndex)) continue;
        inFlight.add(chunkIndex);

        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const slice = new Uint8Array(await file.slice(start, end).arrayBuffer());
        const plaintextHash = await sha256Raw(slice);
        const { iv, ciphertext } = await encryptChunk(sessionKey, slice, chunkIndex);

        channel.send(
          encodeChunkMessage({
            chunkIndex,
            totalChunks,
            plaintextLength: slice.byteLength,
            plaintextHash,
            iv,
            ciphertext,
          }),
        );
      }

      if (channel.bufferedAmount >= BUFFERED_AMOUNT_HIGH) {
        await waitForBufferLow(channel, signal);
      }

      // Drop in-flight that got acked
      for (const i of [...inFlight]) {
        if (acked.has(i)) inFlight.delete(i);
      }

      const bytesTransferred = Math.min(file.size, acked.size * CHUNK_SIZE);
      // clamp final
      const transferred =
        acked.size >= totalChunks ? file.size : Math.min(file.size, bytesTransferred);

      onProgress({
        bytesTransferred: transferred,
        totalBytes: file.size,
        speedBps: speed.push(transferred),
        connectionType: opts.connectionType,
        status: 'transferring',
        fileName: file.name,
      });

      if (acked.size < totalChunks && inFlight.size >= ACK_BATCH) {
        await delay(16, signal);
      } else if (acked.size < totalChunks && nextToSend >= totalChunks) {
        // Waiting on final acks
        await delay(16, signal);
      }
    }

    onProgress({
      bytesTransferred: file.size,
      totalBytes: file.size,
      speedBps: speed.push(file.size),
      connectionType: opts.connectionType,
      status: 'verifying',
      fileName: file.name,
    });

    const fileHash = await hashBlobStreaming(file);
    channel.send(
      encodeJsonMessage(MSG.COMPLETE, { type: 'complete', fileHash }),
    );

    onProgress({
      bytesTransferred: file.size,
      totalBytes: file.size,
      speedBps: 0,
      connectionType: opts.connectionType,
      status: 'done',
      fileName: file.name,
    });
  } finally {
    channel.removeEventListener('message', onMessage);
  }
}

export async function receiveFile(opts: {
  channel: RTCDataChannel;
  sessionKey: CryptoKey;
  connectionType: ConnectionType;
  onProgress: ProgressCallback;
  signal?: AbortSignal;
}): Promise<File> {
  const { channel, sessionKey, onProgress, signal } = opts;
  await waitForChannelOpen(channel, signal);

  const speed = new SpeedTracker();
  let meta: FileMeta | null = null;
  const chunks = new Map<number, Uint8Array>();
  let pendingAcks: number[] = [];
  let expectedFileHash: string | null = null;
  let finished = false;
  let failed: string | null = null;

  const flushAcks = (force = false) => {
    if (!force && pendingAcks.length < ACK_BATCH) return;
    if (pendingAcks.length === 0) return;
    channel.send(
      encodeJsonMessage(MSG.ACK, {
        type: 'ack',
        indices: pendingAcks.splice(0, pendingAcks.length),
      }),
    );
  };

  return new Promise<File>((resolve, reject) => {
    let interval = 0;

    const cleanup = () => {
      channel.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      window.clearInterval(interval);
    };

    const fail = (message: string) => {
      if (failed || finished) return;
      failed = message;
      cleanup();
      try {
        channel.send(encodeJsonMessage(MSG.ERROR, { type: 'error', message }));
      } catch {
        // ignore
      }
      onProgress({
        bytesTransferred: 0,
        totalBytes: meta?.size ?? 0,
        speedBps: 0,
        connectionType: opts.connectionType,
        status: 'failed',
        error: message,
        fileName: meta?.name,
      });
      reject(
        message === 'Transfer cancelled'
          ? new TransferCancelledError(message)
          : new Error(message),
      );
    };

    const onAbort = () => {
      fail('Transfer cancelled');
    };

    const onMessage = (event: MessageEvent) => {
      void (async () => {
        try {
          if (signal?.aborted) {
            fail('Transfer cancelled');
            return;
          }
          if (!(event.data instanceof ArrayBuffer)) return;
          const buf = event.data;
          const type = new DataView(buf).getUint8(0);

          if (type === MSG.FILE_META) {
            const decoded = decodeJsonMessage<FileMeta>(buf);
            if (!decoded) return;
            meta = decoded.payload;
            if (meta.size > MAX_FILE_BYTES) {
              fail('File exceeds the 2 GB MVP limit');
              return;
            }
            onProgress({
              bytesTransferred: 0,
              totalBytes: meta.size,
              speedBps: 0,
              connectionType: opts.connectionType,
              status: 'transferring',
              fileName: meta.name,
            });
            return;
          }

          if (type === MSG.CHUNK) {
            if (!meta) return;
            const chunk = decodeChunkMessage(buf);
            if (!chunk) return;

            const plaintext = await decryptChunk(
              sessionKey,
              chunk.iv,
              chunk.ciphertext,
              chunk.chunkIndex,
            );

            const digest = await sha256Raw(plaintext);
            if (!hashesEqual(digest, chunk.plaintextHash)) {
              channel.send(
                encodeJsonMessage(MSG.NACK, {
                  type: 'nack',
                  chunkIndex: chunk.chunkIndex,
                }),
              );
              fail(`Integrity check failed on chunk ${chunk.chunkIndex}`);
              return;
            }

            chunks.set(chunk.chunkIndex, plaintext);
            pendingAcks.push(chunk.chunkIndex);
            flushAcks();

            const bytesTransferred = Math.min(
              meta.size,
              chunks.size * meta.chunkSize,
            );
            onProgress({
              bytesTransferred:
                chunks.size >= meta.totalChunks ? meta.size : bytesTransferred,
              totalBytes: meta.size,
              speedBps: speed.push(
                chunks.size >= meta.totalChunks ? meta.size : bytesTransferred,
              ),
              connectionType: opts.connectionType,
              status: 'transferring',
              fileName: meta.name,
            });
            return;
          }

          if (type === MSG.COMPLETE) {
            if (!meta) return;
            flushAcks(true);
            const decoded = decodeJsonMessage<{ fileHash: string }>(buf);
            expectedFileHash = decoded?.payload.fileHash ?? null;

            onProgress({
              bytesTransferred: meta.size,
              totalBytes: meta.size,
              speedBps: 0,
              connectionType: opts.connectionType,
              status: 'verifying',
              fileName: meta.name,
            });

            if (chunks.size !== meta.totalChunks) {
              fail('Missing chunks at completion');
              return;
            }

            const hasher = createSha256Hasher();
            const parts: Uint8Array[] = [];
            for (let i = 0; i < meta.totalChunks; i++) {
              const part = chunks.get(i);
              if (!part) {
                fail(`Missing chunk ${i}`);
                return;
              }
              hasher.update(part);
              parts.push(part);
            }

            const blob = new Blob(parts as BlobPart[], { type: meta.mime });
            if (expectedFileHash) {
              const actual = bytesToHex(hasher.digest());
              if (actual !== expectedFileHash) {
                fail('Full-file hash mismatch');
                return;
              }
            }

            const out = new File([blob], meta.name, { type: meta.mime });
            finished = true;
            cleanup();
            onProgress({
              bytesTransferred: meta.size,
              totalBytes: meta.size,
              speedBps: 0,
              connectionType: opts.connectionType,
              status: 'done',
              fileName: meta.name,
            });
            resolve(out);
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : 'Receive failed');
        }
      })();
    };

    channel.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      fail('Transfer cancelled');
      return;
    }

    interval = window.setInterval(() => {
      if (finished || failed) {
        window.clearInterval(interval);
        return;
      }
      if (channel.readyState !== 'open') {
        fail('Connection lost');
      }
    }, 500);
  });
}

export function isTransferCancelled(err: unknown): boolean {
  return (
    err instanceof TransferCancelledError ||
    (err instanceof Error && err.message === 'Transfer cancelled')
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(bps)}/s`;
}

export function connectionLabel(type: ConnectionType): string {
  switch (type) {
    case 'lan':
      return 'Direct · same network';
    case 'p2p':
      return 'Peer-to-peer · internet';
    case 'relay':
      return 'Relay';
    default:
      return 'Connecting…';
  }
}
