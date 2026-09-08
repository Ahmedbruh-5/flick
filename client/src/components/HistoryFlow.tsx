import { useCallback, useState } from 'react';
import {
  clearHistory,
  formatHistoryTime,
  listHistory,
  removeHistoryEntry,
  type HistoryEntry,
} from '../lib/history';
import { connectionLabel, formatBytes } from '../lib/transfer';

type Props = {
  onBack: () => void;
};

export function HistoryFlow({ onBack }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => listHistory());

  const refresh = useCallback(() => {
    setEntries(listHistory());
  }, []);

  const onClear = () => {
    if (entries.length === 0) return;
    if (!window.confirm('Clear all transfer history on this device?')) return;
    clearHistory();
    refresh();
  };

  const onRemove = (id: string) => {
    removeHistoryEntry(id);
    refresh();
  };

  return (
    <section className="flow history-flow">
      <button type="button" className="back" onClick={onBack}>
        ← Back
      </button>

      <header className="flow-header history-header">
        <div>
          <h1>History</h1>
          <p>Transfers on this device only. Nothing is uploaded.</p>
        </div>
        {entries.length > 0 && (
          <button type="button" className="btn ghost compact" onClick={onClear}>
            Clear all
          </button>
        )}
      </header>

      {entries.length === 0 ? (
        <div className="history-empty">
          <p className="history-empty-title">No transfers yet</p>
          <p className="muted">
            Sent and received files will show up here after each transfer.
          </p>
        </div>
      ) : (
        <ul className="history-list">
          {entries.map((entry) => (
            <li key={entry.id} className="history-item">
              <div className="history-item-top">
                <span
                  className={`pill history-dir ${entry.direction === 'sent' ? 'sent' : 'received'}`}
                >
                  {entry.direction === 'sent' ? 'Sent' : 'Received'}
                </span>
                <span
                  className={`pill history-status ${entry.status === 'done' ? 'ok' : 'fail'}`}
                >
                  {entry.status === 'done' ? 'Done' : 'Failed'}
                </span>
              </div>

              <p className="file-name" title={entry.fileName}>
                {entry.fileName}
              </p>

              <div className="history-meta">
                <span>{formatBytes(entry.fileSize)}</span>
                <span aria-hidden>·</span>
                <span>{connectionLabel(entry.connectionType)}</span>
              </div>

              <div className="history-item-bottom">
                <time dateTime={new Date(entry.createdAt).toISOString()}>
                  {formatHistoryTime(entry.createdAt)}
                </time>
                <button
                  type="button"
                  className="history-remove"
                  onClick={() => onRemove(entry.id)}
                  aria-label={`Remove ${entry.fileName} from history`}
                >
                  Remove
                </button>
              </div>

              {entry.error && entry.status === 'failed' && (
                <p className="muted small history-error">{entry.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
