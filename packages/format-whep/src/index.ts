// WebRTC WHEP client (SPEC §8, ADR-008 §8): POST an SDP offer (recvonly video + audio) to the
// endpoint, take the SDP answer (201 + Location), and hand the received MediaStream to the native
// backend (`openStream`). Non-trickle: the offer goes out with its candidates once gathering ends
// (or after a short cap). ICE that does not connect within `connectTimeoutMs`, or fails later, is
// a fatal `iceFailed` error: no retry (a new offer meets the same blocked path), down the fallback
// chain, then to `Source.fallback` (e.g. the HTTP-FLV of the same stream). The WebRTC calls live
// in this package's on-demand chunk (client.ts).

import type { FormatPlugin, Source, StreamContext, StreamSession } from '@otter-player/media';

export interface WhepFormatOptions {
  /** ICE servers for the peer connection (STUN / TURN); default none (host candidates). */
  readonly iceServers?: readonly RTCIceServer[];
  /** ICE must connect within this after the answer, ms. Default 8000. */
  readonly connectTimeoutMs?: number;
  /** Longest wait for ICE gathering before the offer goes out with what it has, ms. Default 1500. */
  readonly gatherTimeoutMs?: number;
}

const WHEP_TYPE = 'application/whep';

/** `type: 'application/whep'`, or a URL whose path has a `whep` segment (`/whep`, `/rtc/v1/whep/`). */
export const isWhep = (source: Source): boolean =>
  source.type === WHEP_TYPE || (typeof source.src === 'string' && /\/whep(?:\/|$|\?)/i.test(source.src));

export function createWhepFormat(options: WhepFormatOptions = {}): FormatPlugin {
  return {
    id: 'whep',
    probe: (source) => (source.type === WHEP_TYPE ? 1 : isWhep(source) ? 0.9 : 0),
    backends: () => (typeof RTCPeerConnection === 'function' ? ['native'] : []),
    createEngine() {
      throw new Error('format-whep feeds the native backend through openStream()');
    },
    async openStream(ctx: StreamContext): Promise<StreamSession> {
      const { connectWhep } = await import('./client.js');
      return connectWhep(ctx, options);
    },
  };
}
