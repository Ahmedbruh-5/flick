import {
  connectionLabel,
  formatBytes,
  formatSpeed,
} from '../lib/transfer';
import type { TransferProgress } from '../lib/types';

type Props = {
  progress: TransferProgress;
};

export function TransferProgressView({ progress }: Props) {
  const pct =
    progress.totalBytes > 0
      ? Math.min(100, (progress.bytesTransferred / progress.totalBytes) * 100)
      : 0;

  return (
    <div className="progress-panel">
      <div className="progress-meta">
        <span className="pill">{connectionLabel(progress.connectionType)}</span>
        <span className="muted">
          {progress.status === 'verifying'
            ? 'Verifying…'
            : progress.status === 'done'
              ? 'Complete'
              : progress.status === 'failed'
                ? 'Failed'
                : formatSpeed(progress.speedBps)}
        </span>
      </div>

      {progress.fileName && <p className="file-name">{progress.fileName}</p>}

      <div className="bar-track" aria-hidden>
        <div className="bar-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="progress-meta">
        <span>
          {formatBytes(progress.bytesTransferred)} /{' '}
          {formatBytes(progress.totalBytes)}
        </span>
        <span>{pct.toFixed(0)}%</span>
      </div>

      {progress.error && <p className="error-text">{progress.error}</p>}
    </div>
  );
}
