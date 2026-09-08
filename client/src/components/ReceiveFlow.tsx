import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { deriveSessionKey, generateKeyPair, type KeyPair } from '../lib/crypto';
import { addHistoryEntry } from '../lib/history';
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
  const [sessionNonce, setSessionNonce] = useState(0);

  const keyPairRef = useRef<KeyPair | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<FlickPeer | null>(null);
  const sessionKeyRef = useRef<CryptoKey | null>(null);
  const receivingRef = useRef(false);
  const connectionTypeRef = useRef<ConnectionType>('unknown');
  const historyRecordedRef = useRef(false);
  const progressRef = useRef<TransferProgress | null>(null);
  const receivedMetaRef = useRef<{ name: string; size: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const phaseRef = useRef<Phase>('starting');

  const cleanup = useCallback(() => {
    peerRef.current?.close();
    peerRef.current = null;
    signalingRef.current?.close();
    signalingRef.current = null;
  }, []);

  const recordReceiveHistory = useCallback(
    (
      status: 'done' | 'failed',
      meta?: { name: string; size: number },
      errorMessage?: string,
    ) => {
      if (historyRecordedRef.current) return;
      const fileMeta =
        meta ??
        receivedMetaRef.current ??
        (progressRef.current?.fileName
          ? {
              name: progressRef.current.fileName,
              size: progressRef.current.totalBytes,
            }
          : null);
      if (!fileMeta) return;
      historyRecordedRef.current = true;
      addHistoryEntry({
        direction: 'received',
        fileName: fileMeta.name,
        fileSize: fileMeta.size,
        status,
        connectionType: connectionTypeRef.current,
        error: errorMessage,
      });
    },
    [],
  );

  const setPhaseTracked = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    abortRef.current = abort;

    historyRecordedRef.current = false;
    receivingRef.current = false;
    connectionTypeRef.current = 'unknown';
    progressRef.current = null;
    receivedMetaRef.current = null;
    keyPairRef.current = null;
    sessionIdRef.current = null;
    sessionKeyRef.current = null;

    setPhaseTracked('starting');
    setCode(null);
    setQrValue(null);
    setError(null);
    setConnectionType('unknown');
    setProgress(null);
    setReceivedFile(null);

    const start = async () => {
      try {
        assertTransferSupport();
        const keyPair = generateKeyPair();
        keyPairRef.current = keyPair;

        const signaling = new SignalingClient({
          onSessionCreated: ({ sessionId, code: shortCode }) => {
            if (cancelled || abort.signal.aborted) return;
            sessionIdRef.current = sessionId;
            setCode(shortCode);
            const payload: PairingPayload = {
              v: 1,
              sessionId,
              code: shortCode,
              publicKey: keyPair.publicKeyHex,
            };
            setQrValue(JSON.stringify(payload));
            setPhaseTracked('waiting');
          },
          onPeerJoined: ({ peerPublicKey }) => {
            void (async () => {
              if (
                cancelled ||
                abort.signal.aborted ||
                !sessionIdRef.current ||
                !keyPairRef.current
              ) {
                return;
              }
              try {
                setPhaseTracked('connecting');
                const sessionKey = await deriveSessionKey(
                  keyPairRef.current.privateKey,
                  peerPublicKey,
                  sessionIdRef.current,
                );
                if (abort.signal.aborted) return;
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
                      if (
                        receivingRef.current ||
                        !sessionKeyRef.current ||
                        abort.signal.aborted
                      ) {
                        return;
                      }
                      receivingRef.current = true;
                      setPhaseTracked('transferring');
                      void receiveFile({
                        channel,
                        sessionKey: sessionKeyRef.current,
                        connectionType: connectionTypeRef.current,
                        signal: abort.signal,
                        onProgress: (p) => {
                          const next = {
                            ...p,
                            connectionType: connectionTypeRef.current,
                          };
                          progressRef.current = next;
                          setProgress(next);
                        },
                      })
                        .then((file) => {
                          if (abort.signal.aborted) return;
                          receivedMetaRef.current = {
                            name: file.name,
                            size: file.size,
                          };
                          setReceivedFile(file);
                          setPhaseTracked('done');
                          recordReceiveHistory('done', {
                            name: file.name,
                            size: file.size,
                          });
                        })
                        .catch((err: unknown) => {
                          if (abort.signal.aborted) return;
                          const message =
                            err instanceof Error
                              ? err.message
                              : 'Transfer failed';
                          setError(message);
                          setPhaseTracked('failed');
                          recordReceiveHistory('failed', undefined, message);
                        });
                    },
                    onError: (message) => {
                      if (abort.signal.aborted) return;
                      setError(message);
                      setPhaseTracked('failed');
                      recordReceiveHistory('failed', undefined, message);
                    },
                  },
                });
                peerRef.current = peer;
              } catch (err) {
                if (abort.signal.aborted) return;
                setError(err instanceof Error ? err.message : 'Failed to connect');
                setPhaseTracked('failed');
              }
            })();
          },
          onSignal: (payload) => {
            void peerRef.current?.handleSignal(payload);
          },
          onPeerLeft: () => {
            if (abort.signal.aborted) return;
            if (phaseRef.current === 'done') return;
            const message = 'Sender disconnected';
            setError(message);
            setPhaseTracked('failed');
            recordReceiveHistory('failed', undefined, message);
          },
          onError: (message) => {
            if (abort.signal.aborted) return;
            setError(message);
            setPhaseTracked('failed');
            recordReceiveHistory('failed', undefined, message);
          },
        });

        signalingRef.current = signaling;
        await signaling.connect();
        if (cancelled || abort.signal.aborted) return;
        signaling.createSession('receiver', keyPair.publicKeyHex);
      } catch (err) {
        if (cancelled || abort.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to start');
        setPhaseTracked('failed');
      }
    };

    void start();

    return () => {
      cancelled = true;
      abort.abort();
      cleanup();
    };
  }, [cleanup, recordReceiveHistory, sessionNonce, setPhaseTracked]);

  const cancelTransfer = () => {
    const message = 'Transfer cancelled';
    abortRef.current?.abort();
    cleanup();
    setError(message);
    setPhaseTracked('failed');
    setProgress((prev) =>
      prev
        ? { ...prev, status: 'failed', error: message, speedBps: 0 }
        : prev,
    );
    recordReceiveHistory('failed', undefined, message);
  };

  const retryReceive = () => {
    abortRef.current?.abort();
    cleanup();
    setSessionNonce((n) => n + 1);
  };

  const goHome = () => {
    abortRef.current?.abort();
    cleanup();
    onBack();
  };

  const download = () => {
    if (!receivedFile) return;
    const url = URL.createObjectURL(receivedFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = receivedFile.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const canCancel =
    phase === 'waiting' ||
    phase === 'connecting' ||
    phase === 'transferring';

  return (
    <section className="flow">
      <button
        type="button"
        className="back"
        onClick={() => {
          if (phase === 'transferring' || phase === 'connecting') {
            cancelTransfer();
            return;
          }
          goHome();
        }}
      >
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

      {canCancel && (
        <div className="done-actions">
          <button
            type="button"
            className="btn ghost full"
            onClick={() => {
              if (phase === 'waiting') {
                goHome();
                return;
              }
              cancelTransfer();
            }}
          >
            {phase === 'waiting' ? 'Cancel' : 'Cancel transfer'}
          </button>
        </div>
      )}

      {phase === 'done' && receivedFile && (
        <div className="done-actions">
          <p className="success-text">
            Got {receivedFile.name} ({formatBytes(receivedFile.size)})
          </p>
          <button type="button" className="btn primary full" onClick={download}>
            Download file
          </button>
          <button type="button" className="btn ghost full" onClick={goHome}>
            Done
          </button>
        </div>
      )}

      {phase === 'failed' && (
        <div className="done-actions">
          <button type="button" className="btn primary full" onClick={retryReceive}>
            Try again
          </button>
          <button type="button" className="btn ghost full" onClick={goHome}>
            Back home
          </button>
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
    </section>
  );
}
