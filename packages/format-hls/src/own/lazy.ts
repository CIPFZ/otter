// The own engine loads with its first use (an on-demand chunk; ADR-010 §2): pages that never play
// HLS do not carry it, and the first screen of the HLS scenarios carries only this wrapper. Every
// Engine member, the optional ones included, goes to the engine once its module is in.
// Type-only imports of the engine; core's helpers are handed to it (CoreHelpers).

import { createError, createEventBus, isOtterError, type Unsubscribe } from '@otter-player/core';
import type { Engine, EngineContext, EngineEvents, TrackList } from '@otter-player/media';
import type { CmafHlsEngineOptions } from './engine.js';

const EVENTS = ['tracks-change', 'quality-change', 'latency-change', 'first-segment', 'bandwidth', 'text-cues', 'error'] as const satisfies readonly (keyof EngineEvents)[];
const NO_TRACKS: TrackList = { video: [], audio: [], text: [], quality: 'opaque', requestedQuality: 'auto' };

type Handler = (p: never) => void;
type OwnEngine = Engine & { seekToLive(): void };

export function lazyCmafHlsEngine(ctx: EngineContext, options: CmafHlsEngineOptions): OwnEngine {
  const handlers = new Map<keyof EngineEvents, Set<Handler>>();
  let engine: OwnEngine | undefined;
  let destroyed = false;
  // Selections made before the module is in.
  let quality: string | undefined;
  let text: string | null | undefined;
  return {
    formatId: 'hls',
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
      const e = (await import('./engine.js')).createCmafHlsEngine(ctx, options, { _createError: createError, _createEventBus: createEventBus, _isOtterError: isOtterError });
      if (destroyed) return e.destroy();
      engine = e;
      for (const type of EVENTS) e.on(type, (p) => handlers.get(type)?.forEach((h) => h(p as never)));
      if (quality !== undefined) e.selectQuality(quality);
      await e.load();
      if (text !== undefined) e.selectTextTrack?.(text);
    },
    selectQuality(id) {
      quality = id;
      engine?.selectQuality(id);
    },
    selectTextTrack(id) {
      text = id;
      engine?.selectTextTrack?.(id);
    },
    selectAudioTrack: (id) => engine?.selectAudioTrack?.(id),
    seekToLive: () => engine?.seekToLive(),
    on(e, h): Unsubscribe {
      let set = handlers.get(e);
      if (set === undefined) handlers.set(e, (set = new Set()));
      set.add(h as Handler);
      return () => set.delete(h as Handler);
    },
    destroy() {
      destroyed = true;
      engine?.destroy();
      handlers.clear();
    },
  };
}
