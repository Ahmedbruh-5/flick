import { useCallback, useRef, useState } from 'react';
import { deriveSessionKey, generateKeyPair, type KeyPair } from '../lib/crypto';
import { assertTransferSupport, secureContextHint } from '../lib/secure';
import { SignalingClient } from '../lib/signaling';
import { formatBytes, sendFile } from '../lib/transfer';
import type {
  ConnectionType,
  PairingPayload,
  TransferProgress,
} from '../lib/types';
import { MAX_FILE_BYTES } from '../lib/types';
import { FlickPeer } from '../lib/webrtc';
import { QrScanner } from './QrScanner';
import { TransferProgressView } from './TransferProgress';

type Phase =
  | 'pick'
  | 'pair'
  | 'connecting'
  | 'transferring'
  | 'done'
  | 'failed';

type Props = {
  onBack: () => void;
};

function parsePairing(raw: string): PairingPayload | null {
  try {
    const data = JSON.parse(raw) as PairingPayload;
    if (data?.v === 1 && data.sessionId && data.publicKey) return data;
  } catch {
    // not JSON
  }
  return null;
}

function normalizeCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}

function formatCodeDisplay(digits: string): string {
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

export function SendFlow({ onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [showScanner, setShowScanner] = useState(false);

  const keyPairRef = useRef<KeyPair | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<FlickPeer | null>(null);
  const connectionTypeRef = useRef<ConnectionType>('unknown');
  const sendingRef = useRef(false);
  const fileRef = useRef<File | null>(null);

  const cleanup = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
  }, []);

  const onFile = (selected: File | null) => {
    setError(null);
    if (!selected) return;
    if (selected.size > MAX_FILE_BYTES) {
      setError(`Max file size is ${formatBytes(MAX_FILE_BYTES)}`);
      return;
    }
    fileRef.current = selected;
    setFile(selected);
    setPhase('pair');
    setShowScanner(false);
    setCameraError(null);
  };

  const beginTransfer = async (opts: {
    sessionId?: string;
    code?: string;
    peerPublicKeyFromQr?: string;
  }) => {
    const selected = fileRef.current;
    if (!selected) return;
    setError(null);
    setShowScanner(false);
    setPhase('connecting');
    sendingRef.current = false;

    try {
      assertTransferSupport();
      cleanup();
      const keyPair = generateKeyPair();
      keyPairRef.current = keyPair;

      let sessionId: string | null = opts.sessionId ?? null;
      let peerPublicKey = opts.peerPublicKeyFromQr ?? null;

      const fail = (message: string) => {
        setError(message);
        setPhase('failed');
      };

      const signaling = new SignalingClient({
        onSessionJoined: (data) => {
          sessionId = data.sessionId;
          peerPublicKey = opts.peerPublicKeyFromQr ?? data.peerPublicKey;
          void setupPeer(signaling, keyPair, sessionId, peerPublicKey, selected).catch(
            (err: unknown) => {
              fail(err instanceof Error ? err.message : 'Failed to set up peer');
            },
          );
        },
        onPeerJoined: (data) => {
          if (!sessionId) return;
          peerPublicKey = data.peerPublicKey;
          void setupPeer(signaling, keyPair, sessionId, peerPublicKey, selected).catch(
            (err: unknown) => {
              fail(err instanceof Error ? err.message : 'Failed to set up peer');
            },
          );
        },
        onSignal: (payload) => {
          void peerRef.current?.handleSignal(payload);
        },
        onPeerLeft: () => {
          fail('Receiver disconnected');
        },
        onError: (message) => {
          fail(message);
        },
      });

      signalingRef.current = signaling;
      await signaling.connect();

      if (opts.sessionId) {
        signaling.joinBySessionId(opts.sessionId, 'sender', keyPair.publicKeyHex);
      } else if (opts.code) {
        signaling.joinByCode(opts.code, 'sender', keyPair.publicKeyHex);
      } else {
        throw new Error('Missing pairing info');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setPhase('failed');
    }
  };

  const setupPeer = async (
    signaling: SignalingClient,
    keyPair: KeyPair,
    sessionId: string,
    peerPublicKey: string,
    selectedFile: File,
  ) => {
    if (peerRef.current) return;

    const sessionKey = await deriveSessionKey(
      keyPair.privateKey,
      peerPublicKey,
      sessionId,
    );

    const peer = new FlickPeer({
      isReceiver: false,
      sendSignal: (payload) => signaling.signal(payload),
      handlers: {
        onConnectionType: (type) => {
          connectionTypeRef.current = type;
          setProgress((prev) =>
            prev ? { ...prev, connectionType: type } : prev,
          );
        },
        onDataChannel: (channel) => {
          if (sendingRef.current) return;
          sendingRef.current = true;
          setPhase('transferring');
          void sendFile({
            file: selectedFile,
            channel,
            sessionKey,
            connectionType: connectionTypeRef.current,
            onProgress: (p) => {
              setProgress({ ...p, connectionType: connectionTypeRef.current });
            },
          })
            .then(() => setPhase('done'))
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : 'Transfer failed');
              setPhase('failed');
            });
        },
        onError: (message) => {
          setError(message);
          setPhase('failed');
        },
      },
    });

    peerRef.current = peer;
    await peer.startOffering();
  };

  const onScan = useCallback((text: string) => {
    const payload = parsePairing(text);
    if (!payload) {
      setError('Unrecognized QR code');
      return;
    }
    setShowScanner(false);
    void beginTransfer({
      sessionId: payload.sessionId,
      code: payload.code,
      peerPublicKeyFromQr: payload.publicKey,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const joinWithCode = () => {
    const code = normalizeCode(codeInput);
    if (code.length !== 6) {
      setError('Enter the 6-digit code from the other device');
      return;
    }
    void beginTransfer({ code });
  };

  return (
    <section className="flow">
      <button
        type="button"
        className="back"
        onClick={() => {
          cleanup();
          onBack();
        }}
      >
        ← Back
      </button>

      <header className="flow-header">
        <h1>Send</h1>
        <p>Pick a file, then enter their code to connect.</p>
      </header>

      {secureContextHint() && (
        <p className="error-text">{secureContextHint()}</p>
      )}

      {phase === 'pick' && (
        <label className="dropzone">
          <input
            type="file"
            className="sr-only"
            onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          />
          <span className="dropzone-title">Choose a file</span>
          <span className="muted">Up to {formatBytes(MAX_FILE_BYTES)}</span>
        </label>
      )}

      {file && phase !== 'pick' && (
        <p className="file-chip">
          {file.name} · {formatBytes(file.size)}
        </p>
      )}

      {phase === 'pair' && (
        <div className="pair-panel">
          <div className="code-entry">
            <label htmlFor="code">Enter 6-digit code</label>
            <div className="code-row">
              <input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={7}
                placeholder="000 000"
                value={formatCodeDisplay(codeInput)}
                onChange={(e) => setCodeInput(normalizeCode(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') joinWithCode();
                }}
              />
              <button type="button" className="btn primary" onClick={joinWithCode}>
                Connect
              </button>
            </div>
          </div>

          <div className="pair-divider">
            <span>or</span>
          </div>

          {!showScanner ? (
            <button
              type="button"
              className="btn ghost full"
              onClick={() => {
                setCameraError(null);
                setShowScanner(true);
              }}
            >
              Scan QR code
            </button>
          ) : (
            <div className="scanner-wrap">
              <QrScanner
                onScan={onScan}
                onError={(message) => {
                  setCameraError(message);
                  setShowScanner(false);
                }}
              />
              <button
                type="button"
                className="btn ghost full"
                onClick={() => setShowScanner(false)}
              >
                Close camera
              </button>
            </div>
          )}

          {cameraError && <p className="muted small">{cameraError}</p>}
        </div>
      )}

      {(phase === 'connecting' ||
        phase === 'transferring' ||
        phase === 'done' ||
        phase === 'failed') && (
        <>
          {phase === 'connecting' && !progress && (
            <p className="muted">Negotiating secure channel…</p>
          )}
          {progress && <TransferProgressView progress={progress} />}
          {phase === 'done' && (
            <div className="done-actions">
              <p className="success-text">Sent successfully.</p>
              <button
                type="button"
                className="btn primary full"
                onClick={() => {
                  cleanup();
                  onBack();
                }}
              >
                Done
              </button>
            </div>
          )}
        </>
      )}

      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
