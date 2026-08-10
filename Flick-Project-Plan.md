# Flick — Project Plan

## What it is
A file-sharing app that lets you send files instantly to any device, nearby or across the internet, with zero setup — no accounts, no cables, no "why isn't this on the same Wi-Fi" headaches.

## Problem it solves
Existing tools force a trade-off. AirDrop/LocalSend-style tools are fast but only work on the same network. Cloud tools (WeTransfer, Google Drive links) work anywhere but are slow, bloated, and require uploads/accounts/waiting. Flick removes the trade-off — it auto-detects whether sender and receiver share a network and picks the fastest path automatically, without the user ever having to think about it.

## Core features
- **Hybrid transfer engine** — same-Wi-Fi transfers go direct over the local network (no server, no internet needed); cross-network transfers fall back to peer-to-peer over the internet (WebRTC)
- **QR code pairing**, with a manual fallback code if the camera fails or isn't available
- **No accounts, no login** — open the app, tap send or receive, done
- **Session-based resumability** — a dropped connection resumes automatically as long as the app stays open
- **Live transfer speed + connection type shown** — so "fast" is provable, not just a claim
- **Cross-platform** — web app first, then mobile (React Native) and eventually desktop
- Multi-file/folder support and text/clipboard sharing are explicitly **cut from MVP** — see below

---

## Protocol and security

Every transfer is end-to-end encrypted, regardless of path (same Wi-Fi, P2P internet, or relay). The network itself is never trusted — encryption happens between devices, not by relying on Wi-Fi or TLS alone.

**Pairing and key exchange**
- Each session generates an ephemeral X25519 keypair on both devices.
- The QR code encodes: device's public key, a session ID, and connection info (local IP/port for LAN, or signaling session ID for remote).
- Both sides run ECDH to derive a shared secret, then HKDF derives an AES-256-GCM session key. This key never touches a server.
- **Manual fallback code**: a 6-digit numeric code (not 3–4 digits — those are brute-forceable in seconds even for a short-lived local session). The code maps to the same session ID/key exchange the QR would have triggered, just typed instead of scanned.

**Transport**
- **Same Wi-Fi**: direct TCP/UDP socket between devices, with the AES-256-GCM session key encrypting the payload on top (so even local network encryption isn't assumed).
- **Cross-network**: WebRTC data channels, which mandate DTLS-SRTP encryption at the transport layer — the app-layer AES-256-GCM sits on top of that as a second layer, so the payload is never plaintext even to any relay.
- **NAT traversal**: public STUN servers (free, e.g. Google's) for the MVP/testing phase. TURN relay (needed for symmetric-NAT cases) is deferred until you're ready to deploy — noted under infra below.

**Integrity**
- Every chunk carries a SHA-256 checksum; a failed checksum triggers a re-request for that chunk, not the whole file.
- The full file is re-hashed and verified on completion.

**Resumability (decided: session-only)**
- Chunk state (sent/acked) lives in memory on both sender and receiver.
- If the connection drops, reconnecting resumes from the last acked chunk.
- If either app is closed or refreshed, the transfer is gone — shown as a clear "transfer failed, try again," nothing silently retried from disk or server.

---

## Pairing edge cases
- QR scan fails or camera permission denied → manual 6-digit code entry, always visible as a fallback option, not hidden in a menu.
- Same-Wi-Fi detection uses mDNS where available; if mDNS is blocked (some routers/corporate networks), Flick falls back to the QR/code pairing path over the internet, so the app never just fails silently.

---

## File size limits
**Recommended MVP cap: 2 GB per file.**
- Files are streamed in chunks (via `File.slice()`), not loaded fully into memory, so this isn't a hard technical ceiling — it's a deliberate UX/testing boundary.
- 2 GB comfortably covers the realistic MVP use case (documents, photos, zipped folders, most videos) without you needing to handle edge cases like multi-gigabyte streaming, mobile background-transfer limits, or browser tab memory pressure this early.
- Raise this later once you've tested real transfers and know where memory/performance actually breaks.

## Browser compatibility
- Target: latest two versions of Chrome, Firefox, Edge, and Safari.
- Safari needs explicit testing — its WebRTC data channel buffering (`bufferedAmount` backpressure handling) behaves differently from Chromium browsers and is a common silent-failure point.
- Feature-detect WebRTC and mDNS/local discovery support on load; if unsupported, show a direct message ("this browser doesn't support direct transfers — try Chrome or Firefox") instead of a silent failure.

---

## Tech stack
- **Frontend (web)**: React + Vite, Tailwind
- **Mobile**: React Native (Expo, dev client for native modules)
- **Backend**: Node.js + Express, `ws` for WebSocket signaling
- **P2P**: WebRTC data channels; public STUN for now, TURN deferred
- **Local network discovery**: mDNS/UDP broadcast
- **Local dev/testing**: LAN IP for same-network testing, ngrok/Cloudflare Tunnel for simulating cross-network demos

**Infra/deployment — intentionally deferred.** You're building and testing this entirely locally/free for now. No hosting, TURN server, or scaling decisions until after you've tested with real users and are ready to demo — revisit this section then.

---

## MVP scope
**In:**
- Single-file transfer (any file type, up to 2 GB)
- Hybrid engine: direct LAN transfer + WebRTC P2P with STUN
- QR pairing + 6-digit manual fallback
- End-to-end encryption (ECDH + AES-256-GCM) on every path
- Session-based resumability
- Live speed/connection-type display
- Web app only

**Out (fast-follow, not MVP):**
- Multi-file/folder transfer
- Text/clipboard sharing
- TURN relay fallback (add once you deploy)
- Mobile and desktop apps
- Any account or history feature

---

## Suggested next step
Nail down the exact chunk/ack message format that goes over the data channel (chunk size, header fields, ack batching) — that's the last piece standing between this plan and writing code.
