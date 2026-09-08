/** WebRTC + Web Crypto only work in a secure context (HTTPS or localhost). */
export function assertTransferSupport(): void {
  if (!window.isSecureContext) {
    throw new Error(
      'This page is not secure. On your phone open the HTTPS URL from your Mac (https://192.168.x.x:5176), then accept the certificate warning.',
    );
  }

  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error(
      'WebRTC is unavailable in this browser. Try Chrome or Firefox over HTTPS.',
    );
  }

  if (!crypto?.subtle) {
    throw new Error(
      'Secure crypto is unavailable. Use the HTTPS Network URL, not plain http://.',
    );
  }
}

export function secureContextHint(): string | null {
  if (window.isSecureContext) return null;
  return 'Open this app with HTTPS (the Network URL Vite prints). Plain http:// on a phone IP blocks WebRTC, so transfers cannot start.';
}
