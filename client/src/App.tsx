import { useState } from 'react';
import { ReceiveFlow } from './components/ReceiveFlow';
import { SendFlow } from './components/SendFlow';
import './App.css';

type Mode = 'home' | 'send' | 'receive';

export default function App() {
  const [mode, setMode] = useState<Mode>('home');

  if (mode === 'send') return <SendFlow onBack={() => setMode('home')} />;
  if (mode === 'receive') return <ReceiveFlow onBack={() => setMode('home')} />;

  return (
    <div className="shell">
      <div className="atmosphere" aria-hidden />
      <main className="hero">
        <p className="brand">Flick</p>
        <h1 className="tagline">Send a file to any device. Instantly.</h1>
        <p className="lede">
          No accounts. No cables. Same Wi‑Fi or across the internet — Flick picks
          the fastest path.
        </p>
        <div className="cta-row">
          <button type="button" className="btn primary" onClick={() => setMode('send')}>
            Send
          </button>
          <button type="button" className="btn ghost" onClick={() => setMode('receive')}>
            Receive
          </button>
        </div>
      </main>
    </div>
  );
}
