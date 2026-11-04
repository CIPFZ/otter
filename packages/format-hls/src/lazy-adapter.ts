// An engine adapter that loads with its first use (2026-11-04, ADR-014 §6): format-hls builds the
// Shaka adapter only for DRM sources and the hls.js adapter only when the own engine hands a
// stream over, so neither adapter's code is part of what an HLS page loads up front (the CDN
// entries, the first screen). Every Engine member goes to the adapter once its module is in;
// selections made before that are applied then.

import { createEventBus, type Unsubscribe } from '@otter-player/core';
import type { Engine, EngineEvents, TrackList } from '@otter-player/media';

const EVENTS = ['tracks-change', 'quality-change', 'latency-change', 'first-segment', 'bandwidth', 'text-cues', 'error'] as const satisfies readonly (keyof EngineEvents)[];
const NO_TRACKS: TrackList = { video: [], audio: [], text: [], quality: 'opaque', requestedQuality: 'auto' };

/** An Engine whose implementation `create` makes once `load()` runs. */
export function lazyEngine(formatId: string, create: () => Promise<Engine>): Engine & { seekToLive(): void } {
  const bus = createEventBus<EngineEvents>();
  let engine: Engine | undefined;
  let destroyed = false;
  let quality: string | undefined;
  let text: string | null | undefined;
  let audio: string | undefined;
  return {
    formatId,
    get tracks() {
      return engine?.tracks ?? NO_TRACKS;
    },
    get latency() {
      return engine?.latency;
    },
    get targetLatency() {
      return engine?.targetLatency;
    },
    get mms() {
      return engine?.mms ?? false;
    },
    async load() {
      const e = await create();
      if (destroyed) return e.destroy();
      engine = e;
      for (const type of EVENTS) e.on(type, (p) => bus.emit(type, p as never));
      if (quality !== undefined) e.selectQuality(quality);
      await e.load();
      if (text !== undefined) e.selectTextTrack?.(text);
      if (audio !== undefined) e.selectAudioTrack?.(audio);
    },
    selectQuality(id) {
      quality = id;
      engine?.selectQuality(id);
    },
    selectTextTrack(id) {
      text = id;
      engine?.selectTextTrack?.(id);
    },
    selectAudioTrack(id) {
      audio = id;
      engine?.selectAudioTrack?.(id);
    },
    seekToLive: () => engine?.seekToLive?.(),
    thumbnails: () => engine?.thumbnails?.() ?? null,
    on: (e, h): Unsubscribe => bus.on(e, (p) => h(p)),
    destroy() {
      destroyed = true;
      engine?.destroy();
      bus.clear();
    },
  };
}
