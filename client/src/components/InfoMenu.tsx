import { useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../lib/version';

type Props = {
  onHistory: () => void;
};

export function InfoMenu({ onHistory }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="info-menu" ref={rootRef}>
      <button
        type="button"
        className="info-menu-trigger"
        aria-label="App info"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <svg
          className="info-menu-icon"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
        >
          <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M12 11v5.5M12 8.25h.01"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div className="info-menu-dropdown" role="menu">
          <p className="info-menu-version" role="presentation">
            Version {APP_VERSION}
          </p>
          <button
            type="button"
            className="info-menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onHistory();
            }}
          >
            History
          </button>
        </div>
      )}
    </div>
  );
}
