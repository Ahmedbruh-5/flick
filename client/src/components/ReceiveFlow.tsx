import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { deriveSessionKey, generateKeyPair, type KeyPair } from '../lib/crypto';
import { assertTransferSupport, secureContextHint } from '../lib/secure';
import { SignalingClient } from '../lib/signaling';
import {
  connectionLabel,
  formatBytes,
  receiveFile,
} from '../lib/transfer';
import type {
  ConnectionType,
  PairingPayload,
  TransferProgress,
} from '../lib/types';
import { FlickPeer } from '../lib/webrtc';
import { TransferProgressView } from './TransferProgress';

type Phase =
  | 'starting'
  | 'waiting'
  | 'connecting'
  | 'transferring'
  | 'done'
  | 'failed';

type Props = {
  onBack: () => void;
};

export function ReceiveFlow({ onBack }: Props) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [code, setCode] = useState<string | null>(null);
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionType, setConnectionType] = useState<ConnectionType>('unknown');
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [receivedFile, setReceivedFile] = useState<File | null>(null);

  const keyPairRef = useRef<KeyPair | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<FlickPeer | null>(null);
  const sessionKeyRef = useRef<CryptoKey | null>(null);
  const receivingRef = useRef(false);
  const connectionTypeRef = useRef<ConnectionType>('unknown');

  const cleanup = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      try {
        assertTransferSupport();
        const keyPair = generateKeyPair();
        keyPairRef.current = keyPair;

        const signaling = new SignalingClient({
          onSessionCreated: ({ sessionId, code: shortCode }) => {
            if (cancelled) return;
            sessionIdRef.current = sessionId;
            setCode(shortCode);
            const payload: PairingPayload = {
              v: 1,
              sessionId,
              code: shortCode,
              publicKey: keyPair.publicKeyHex,
            };
            setQrValue(JSON.stringify(payload));
            setPhase('waiting');
          },
          onPeerJoined: ({ peerPublicKey }) => {
            void (async () => {
              if (cancelled || !sessionIdRef.current || !keyPairRef.current) return;
              try {
                setPhase('connecting');
                const sessionKey = await deriveSessionKey(
                  keyPairRef.current.privateKey,
                  peerPublicKey,
                  sessionIdRef.current,
                );
                sessionKeyRef.current = sessionKey;

                const peer = new FlickPeer({
                  isReceiver: true,
                  sendSignal: (payload) => signaling.signal(payload),
                  handlers: {
                    onConnectionType: (type) => {
                      connectionTypeRef.current = type;
                      setConnectionType(type);
                    },
                    onDataChannel: (channel) => {
                      if (receivingRef.current || !sessionKeyRef.current) return;
                      receivingRef.current = true;
                      setPhase('transferring');
                      void receiveFile({
                        channel,
                        sessionKey: sessionKeyRef.current,
                        connectionType: connectionTypeRef.current,
                        onProgress: (p) => {
                          setProgress({
                            ...p,
                            connectionType: connectionTypeRef.current,
                          });
                        },
                      })
                        .then((file) => {
                          setReceivedFile(file);
                          setPhase('done');
                        })
                        .catch((err: unknown) => {
                          setError(
                            err instanceof Error ? err.message : 'Transfer failed',
                          );
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
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to connect');
                setPhase('failed');
              }
            })();
          },
          onSignal: (payload) => {
            void peerRef.current?.handleSignal(payload);
          },
          onPeerLeft: () => {
            setPhase((current) => {
              if (current === 'done') return current;
              setError('Sender disconnected');
              return 'failed';
            });
          },
          onError: (message) => {
            setError(message);
            setPhase('failed');
          },
        });

        signalingRef.current = signaling;
        await signaling.connect();
        signaling.createSession('receiver', keyPair.publicKeyHex);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to start');
        setPhase('failed');
      }
    };

    void start();

    return () => {
      cancelled = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanup]);

  const download = () => {
    if (!receivedFile) return;
    const url = URL.createObjectURL(receivedFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = receivedFile.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="flow">
      <button type="button" className="back" onClick={onBack}>
        ← Back
      </button>

      <header className="flow-header">
        <h1>Receive</h1>
        <p>Show this code to the sender. Transfer starts when they connect.</p>
      </header>

      {secureContextHint() && (
        <p className="error-text">{secureContextHint()}</p>
      )}

      {phase === 'starting' && <p className="muted">Creating secure session…</p>}

      {(phase === 'waiting' || phase === 'connecting') && code && (
        <div className="pairing-card">
          {qrValue && (
            <div className="qr-wrap">
              <QRCodeSVG value={qrValue} size={220} bgColor="transparent" fgColor="#f4f7f2" />
            </div>
          )}
          <p className="code-label">Or enter this code</p>
          <p className="code-digits" aria-label="Pairing code">
            {code.slice(0, 3)} {code.slice(3)}
          </p>
          <p className="muted small">
            {phase === 'waiting'
              ? 'Waiting for sender…'
              : `Connecting · ${connectionLabel(connectionType)}`}
          </p>
        </div>
      )}

      {(phase === 'transferring' || phase === 'done' || phase === 'failed') &&
        progress && <TransferProgressView progress={progress} />}

      {phase === 'done' && receivedFile && (
        <div className="done-actions">
          <p className="success-text">
            Got {receivedFile.name} ({formatBytes(receivedFile.size)})
          </p>
          <button type="button" className="btn primary full" onClick={download}>
            Download file
          </button>
          <button
            type="button"
            className="btn ghost full"
            onClick={() => {
              cleanup();
              onBack();
            }}
          >
            Done
          </button>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
