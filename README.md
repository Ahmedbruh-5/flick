# Flick

Send a file to any device instantly — same Wi‑Fi or across the internet. No accounts.

## Quick start

```bash
# Terminal 1 — signaling server
cd server && npm run dev

# Terminal 2 — web app (HTTPS enabled for phone testing)
cd client && npm run dev
```

Open the **HTTPS Network** URL Vite prints (e.g. `https://192.168.1.9:5173`) on both devices.

On a phone you’ll see a certificate warning — tap Advanced → Proceed. Plain `http://` on a LAN IP will hang forever: browsers block WebRTC there.

1. On device A: **Receive** → show QR / 6-digit code  
2. On device B: **Send** → pick a file → enter the code  
3. Watch speed + connection type (LAN / P2P) while it transfers

Signaling is proxied through Vite (`/ws`), so phones only need port **5173**.

## Stack

- **Client**: React + Vite + Tailwind
- **Signaling**: Node.js + Express + `ws`
- **Transport**: WebRTC data channels (STUN only for now — TURN deferred)
- **Crypto**: X25519 ECDH → HKDF → AES-256-GCM per chunk

## Notes

- Browsers can't open raw TCP sockets, so “same network” is WebRTC with **host** ICE candidates (still direct/LAN-fast).
- Max file size for MVP: **2 GB**
- Session-only resumability: refresh or close the tab and the transfer is gone
- STUN-only will fail on some NATs until TURN is added

## Project layout

```
client/   Web app
server/   Pairing + WebRTC signaling
Flick-Project-Plan.md
```
