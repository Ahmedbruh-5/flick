import { STUN_SERVERS, type ConnectionType, type SignalPayload } from './types';

export type PeerHandlers = {
  onDataChannel?: (channel: RTCDataChannel) => void;
  onConnectionType?: (type: ConnectionType) => void;
  onIceConnectionState?: (state: RTCIceConnectionState) => void;
  onError?: (message: string) => void;
};

function classifyCandidateType(type: string | null | undefined): ConnectionType {
  switch (type) {
    case 'host':
      return 'lan';
    case 'srflx':
    case 'prflx':
      return 'p2p';
    case 'relay':
      return 'relay';
    default:
      return 'unknown';
  }
}

export class FlickPeer {
  readonly pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;
  private readonly polite: boolean;
  private readonly sendSignal: (payload: SignalPayload) => void;
  private readonly handlers: PeerHandlers;
  private makingOffer = false;

  constructor(opts: {
    /** Receiver is polite (waits / answers); sender is impolite (offers). */
    isReceiver: boolean;
    sendSignal: (payload: SignalPayload) => void;
    handlers?: PeerHandlers;
  }) {
    this.polite = opts.isReceiver;
    this.sendSignal = opts.sendSignal;
    this.handlers = opts.handlers ?? {};

    this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal({
          kind: 'ice',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      this.handlers.onIceConnectionState?.(this.pc.iceConnectionState);
      void this.refreshConnectionType();
    };

    this.pc.onconnectionstatechange = () => {
      void this.refreshConnectionType();
    };

    this.pc.ondatachannel = (event) => {
      this.channel = event.channel;
      this.configureChannel(this.channel);
      this.handlers.onDataChannel?.(this.channel);
    };

    // Sender creates the data channel
    if (!opts.isReceiver) {
      this.channel = this.pc.createDataChannel('flick', {
        ordered: true,
      });
      this.configureChannel(this.channel);
      this.handlers.onDataChannel?.(this.channel);
    }
  }

  private configureChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
  }

  get dataChannel(): RTCDataChannel | null {
    return this.channel;
  }

  async startOffering(): Promise<void> {
    if (this.polite) return;
    await this.makeOffer();
  }

  private async makeOffer(): Promise<void> {
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal({
        kind: 'offer',
        sdp: {
          type: this.pc.localDescription!.type,
          sdp: this.pc.localDescription!.sdp,
        },
      });
    } catch (err) {
      this.handlers.onError?.(
        err instanceof Error ? err.message : 'Failed to create offer',
      );
    } finally {
      this.makingOffer = false;
    }
  }

  async handleSignal(payload: SignalPayload): Promise<void> {
    try {
      if (payload.kind === 'offer') {
        const offerCollision =
          this.makingOffer || this.pc.signalingState !== 'stable';
        if (offerCollision && !this.polite) return;

        await this.pc.setRemoteDescription(payload.sdp);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendSignal({
          kind: 'answer',
          sdp: {
            type: this.pc.localDescription!.type,
            sdp: this.pc.localDescription!.sdp,
          },
        });
        return;
      }

      if (payload.kind === 'answer') {
        await this.pc.setRemoteDescription(payload.sdp);
        return;
      }

      if (payload.kind === 'ice') {
        try {
          await this.pc.addIceCandidate(payload.candidate);
        } catch {
          // Ignore candidates that arrive before remote description
        }
      }
    } catch (err) {
      this.handlers.onError?.(
        err instanceof Error ? err.message : 'Signaling error',
      );
    }
  }

  private async refreshConnectionType(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      let selected: RTCStats | undefined;
      stats.forEach((report) => {
        if (
          report.type === 'candidate-pair' &&
          (report as RTCIceCandidatePairStats).state === 'succeeded' &&
          (report as RTCIceCandidatePairStats).nominated
        ) {
          selected = report;
        }
      });
      if (!selected) return;

      const pair = selected as RTCIceCandidatePairStats;
      const local = stats.get(pair.localCandidateId ?? '');
      const type =
        local && local.type === 'local-candidate'
          ? classifyCandidateType(
              (local as RTCStats & { candidateType?: string }).candidateType,
            )
          : 'unknown';
      this.handlers.onConnectionType?.(type);
    } catch {
      // stats not available
    }
  }

  close(): void {
    try {
      this.channel?.close();
    } catch {
      // ignore
    }
    try {
      this.pc.close();
    } catch {
      // ignore
    }
  }
}
