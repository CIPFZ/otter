// Live sources for the WebCodecs backend: one bounded packet history per track, shared by all
// readers. A subscriber keeps a cursor, not another copy of the history. If its cursor expires,
// video resumes at a keyframe; the backend uses startTime to resynchronise both tracks and clock.

import type { EncodedChunk } from './decoder.js';
import type { PacketStream } from './demux.js';

export interface LivePacket {
  readonly key: boolean;
  /** µs on the media timeline. */
  readonly timestamp: number;
  readonly duration?: number;
  readonly data: Uint8Array;
}

export interface LiveFanout {
  push(track: 'video' | 'audio', packet: LivePacket): void;
  /** The stream ended: readers finish once they have what was sent. */
  end(): void;
  /** Earliest retained keyframe (audio: frame), seconds; Infinity while none is available. */
  startTime(track: 'video' | 'audio'): number;
  /** Packets from a retained keyframe (audio: frame) at or before time, then new packets. */
  packets(track: 'video' | 'audio', time: number): PacketStream;
}

interface Subscriber {
  next: number;
  needsKey: boolean;
  wake: (() => void) | undefined;
  done: boolean;
}

/**
 * Shares a time window subject to independent per-track storage limits. A high-bitrate source
 * may retain less than historyS. Limits must be positive safe integers. An oversized packet or
 * non-finite timestamp breaks continuity; video readers wait for the next retained keyframe.
 */
export function createLiveFanout(historyS = 15, limits: {
  /** Maximum retained payload bytes per track; defaults to 64 MiB. */
  readonly maxBytes?: number;
  /** Maximum retained packets per track; defaults to 8192, even when timestamps do not advance. */
  readonly maxPackets?: number;
} = {}): LiveFanout {
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
  const maxPackets = limits.maxPackets ?? 8192;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxPackets) || maxPackets <= 0) {
    throw new RangeError('live history limits must be positive safe integers');
  }
  const tracks = {
    video: { history: [] as LivePacket[], first: 0, bytes: 0, subscribers: new Set<Subscriber>() },
    audio: { history: [] as LivePacket[], first: 0, bytes: 0, subscribers: new Set<Subscriber>() },
  };
  let ended = false;

  const startIndex = (kind: 'video' | 'audio', time: number): number => {
    const h = tracks[kind].history;
    const t = time * 1e6;
    if (kind === 'audio') {
      const i = h.findIndex((p) => p.timestamp + (p.duration ?? 0) > t);
      return i < 0 ? h.length : i;
    }
    let best = -1;
    for (let i = 0; i < h.length; i++) {
      const p = h[i] as LivePacket;
      if (!p.key) continue;
      if (p.timestamp <= t || best < 0) best = i;
      if (p.timestamp > t) break;
    }
    return best < 0 ? h.length : best;
  };

  return {
    push(kind, p) {
      const track = tracks[kind];
      const size = p.data.byteLength;
      if (!Number.isFinite(p.timestamp) || size > maxBytes) {
        // The discarded packet may be a decoder reference. Invalidate every earlier cursor so
        // no reader joins a later delta to a sequence with a missing packet.
        track.first += track.history.length + 1;
        track.history.length = 0;
        track.bytes = 0;
      } else {
        while (track.history.length > 0 && (
          (track.history[0] as LivePacket).timestamp < p.timestamp - historyS * 1e6 ||
          track.history.length >= maxPackets || track.bytes + size > maxBytes
        )) {
          track.bytes -= (track.history.shift() as LivePacket).data.byteLength;
          track.first++;
        }
        // Own the retained storage: a tiny view must not pin an arbitrarily large input buffer.
        track.history.push({ ...p, data: p.data.slice() });
        track.bytes += size;
      }
      for (const s of track.subscribers) s.wake?.();
    },
    end() {
      ended = true;
      for (const t of Object.values(tracks)) for (const s of t.subscribers) s.wake?.();
    },
    startTime(kind) {
      const h = tracks[kind].history;
      const first = kind === 'video' ? h.find((p) => p.key) : h[0];
      return first === undefined ? Number.POSITIVE_INFINITY : first.timestamp / 1e6;
    },
    packets(kind, time) {
      const track = tracks[kind];
      const sub: Subscriber = { next: track.first + startIndex(kind, time), needsKey: kind === 'video', wake: undefined, done: false };
      track.subscribers.add(sub);
      const close = (): void => {
        sub.done = true;
        track.subscribers.delete(sub);
        sub.wake?.();
      };
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EncodedChunk>> {
              while (!sub.done) {
                if (sub.next < track.first) {
                  sub.next = track.first + startIndex(kind, Number.NEGATIVE_INFINITY);
                  sub.needsKey = kind === 'video';
                }
                const p = track.history[sub.next - track.first];
                if (p !== undefined) {
                  sub.next++;
                  if (sub.needsKey && !p.key) continue;
                  sub.needsKey = false;
                  return { done: false, value: { type: p.key ? 'key' : 'delta', timestamp: p.timestamp, data: p.data.slice().buffer, ...(p.duration === undefined ? {} : { duration: p.duration }) } };
                }
                if (ended) break;
                await new Promise<void>((r) => (sub.wake = r));
                sub.wake = undefined;
              }
              close();
              return { done: true, value: undefined };
            },
            async return(): Promise<IteratorResult<EncodedChunk>> {
              close();
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
}
