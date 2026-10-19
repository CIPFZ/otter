// The Range engine loads with its first use: single files play natively and never need it, so
// pages with progressive video (short video, Hero) do not carry it (SPEC §19 budgets). The
// wrapper forwards the Engine contract once the module is in. Type-only imports: a value import
// shared with the engine chunk would make that module eagerly initialised (side-effects gate).

import type { Unsubscribe } from '@otter-player/core';
import type { Engine, EngineEvents, TrackList } from '@otter-player/media';

const EVENTS = ['tracks-change', 'quality-change', 'latency-change', 'first-segment', 'bandwidth', 'text-cues', 'error'] as const satisfies readonly (keyof EngineEvents)[];
const NO_TRACKS: TrackList = { video: [], audio: [], text: [], quality: 'opaque', requestedQuality: 'auto' };

type Handler = (p: never) => void;

export function lazyEngine(formatId: string, create: () => Promise<Engine>): Engine {
  const handlers = new Map<keyof EngineEvents, Set<Handler>>();
  let engine: Engine | undefined;
  let destroyed = false;
  return {
    formatId,
    get tracks() {
      return engine?.tracks ?? NO_TRACKS;
    },
    get latency() {
      return engine?.latency;
    },
    get mms() {
      return engine?.mms ?? false;
    },
    async load() {
      const e = await create();
      if (destroyed) return e.destroy();
      engine = e;
      for (const type of EVENTS) e.on(type, (p) => handlers.get(type)?.forEach((h) => h(p as never)));
      await e.load();
    },
    selectQuality: (id) => engine?.selectQuality(id),
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
