import { useEffect, useId, useRef } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

type Props = {
  onScan: (text: string) => void;
  onError?: (message: string) => void;
};

async function safeStop(scanner: Html5Qrcode | null): Promise<void> {
  if (!scanner) return;
  try {
    const state = scanner.getState?.();
    // 2 = SCANNING, 3 = PAUSED
    if (state === 2 || state === 3) {
      await scanner.stop();
    }
  } catch {
    // ignore
  }
  try {
    scanner.clear();
  } catch {
    // ignore
  }
}

function emptyContainer(elementId: string): void {
  const el = document.getElementById(elementId);
  if (el) el.replaceChildren();
}

export function QrScanner({ onScan, onError }: Props) {
  const reactId = useId().replace(/:/g, '');
  const elementId = `flick-qr-${reactId}`;
  const onScanRef = useRef(onScan);
  const onErrorRef = useRef(onError);
  onScanRef.current = onScan;
  onErrorRef.current = onError;

  useEffect(() => {
    let cancelled = false;
    let scanner: Html5Qrcode | null = null;
    // React StrictMode mounts → unmounts → remounts. Wait for the first
    // cleanup to finish so we never stack two live <video> elements.
    const startTimer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        emptyContainer(elementId);

        try {
          scanner = new Html5Qrcode(elementId, {
            formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
            verbose: false,
          });

          await scanner.start(
            { facingMode: 'environment' },
            { fps: 8, qrbox: { width: 220, height: 220 } },
            (decoded) => {
              if (cancelled) return;
              onScanRef.current(decoded);
              void safeStop(scanner);
            },
            () => undefined,
          );

          if (cancelled) {
            await safeStop(scanner);
            emptyContainer(elementId);
          }
        } catch (err: unknown) {
          if (cancelled) return;
          onErrorRef.current?.(
            err instanceof Error
              ? err.message
              : 'Camera unavailable — use the code instead',
          );
        }
      })();
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      void (async () => {
        await safeStop(scanner);
        emptyContainer(elementId);
      })();
    };
  }, [elementId]);

  return <div id={elementId} className="qr-reader" />;
}
