// Live sources for the WebCodecs backend (ADR-013 §7): packets of an endless stream fanned out to
// the backend's readers. The backend asks for packets from a time (start, seek, audio started at the
// first gesture); each ask is a subscriber that starts at the most recent keyframe at or before it
// (audio: the frame covering it), out of the last `historyS` of packets, and then gets every new
// packet. Used by the FLV demuxer (engine-pipeline) and the live MPEG-TS one (demux-mediabunny).

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
  /** Packets from the keyframe (audio: frame) at or before `time` (s), then every new one. */
  packets(track: 'video' | 'audio', time: number): PacketStream;
}

interface Subscriber {
  readonly queue: LivePacket[];
  wake: (() => void) | undefined;
  done: boolean;
}

export function createLiveFanout(historyS = 15): LiveFanout {
  const tracks = { video: { history: [] as LivePacket[], subscribers: new Set<Subscriber>() }, audio: { history: [] as LivePacket[], subscribers: new Set<Subscriber>() } };
  let ended = false;

  const startIndex = (kind: 'video' | 'audio', time: number): number => {
    const h = tracks[kind].history;
    const t = time * 1e6;
    if (kind === 'audio') {
      const i = h.findIndex((p) => p.timestamp + (p.duration ?? 0) > t);
      return i < 0 ? h.length : i;
    }
    // The last keyframe at or before t; before the history: its first keyframe.
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
      track.history.push(p);
      while (track.history.length > 0 && (track.history[0] as LivePacket).timestamp < p.timestamp - historyS * 1e6) track.history.shift();
      for (const s of track.subscribers) {
        s.queue.push(p);
        s.wake?.();
      }
    },
    end() {
      ended = true;
      for (const t of Object.values(tracks)) for (const s of t.subscribers) s.wake?.();
    },
    packets(kind, time) {
      const track = tracks[kind];
      const sub: Subscriber = { queue: track.history.slice(startIndex(kind, time)), wake: undefined, done: false };
      track.subscribers.add(sub);
      const close = (): void => {
        sub.done = true;
        track.subscribers.delete(sub);
      };
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EncodedChunk>> {
              while (!sub.done) {
                const p = sub.queue.shift();
                if (p !== undefined) {
                  // Each subscriber its own bytes: decoders may transfer them to a Worker.
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
