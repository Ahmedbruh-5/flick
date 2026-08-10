import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** Copy into a view backed by ArrayBuffer for Web Crypto BufferSource typing. */
function asAb(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
}

export function generateKeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    publicKeyHex: bytesToHex(publicKey),
  };
}

export function deriveSessionKey(
  privateKey: Uint8Array,
  peerPublicKeyHex: string,
  sessionId: string,
): Promise<CryptoKey> {
  const shared = x25519.getSharedSecret(privateKey, hexToBytes(peerPublicKeyHex));
  const info = utf8ToBytes(`flick-session:${sessionId}`);
  const salt = utf8ToBytes('flick-v1');
  const rawKey = asAb(hkdf(sha256, shared, salt, info, 32));

  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptChunk(
  key: CryptoKey,
  plaintext: Uint8Array,
  chunkIndex: number,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // Bind chunk index into AAD so chunks can't be reordered/replayed
  const aad = new Uint8Array(4);
  new DataView(aad.buffer).setUint32(0, chunkIndex, false);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      asAb(plaintext),
    ),
  );

  return { iv, ciphertext };
}

export async function decryptChunk(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  chunkIndex: number,
): Promise<Uint8Array> {
  const aad = new Uint8Array(4);
  new DataView(aad.buffer).setUint32(0, chunkIndex, false);

  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asAb(iv), additionalData: aad },
      key,
      asAb(ciphertext),
    ),
  );
}

export async function hashBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', asAb(data));
  return bytesToHex(new Uint8Array(digest));
}

/** Stream a blob through SHA-256 without loading it all at once. */
export async function hashBlobStreaming(
  blob: Blob,
  chunkSize = 1024 * 1024,
): Promise<string> {
  const hasher = sha256.create();
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + chunkSize, blob.size);
    const slice = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    hasher.update(slice);
    offset = end;
  }
  return bytesToHex(hasher.digest());
}

export function createSha256Hasher() {
  return sha256.create();
}
