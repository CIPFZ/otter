// Pipeline -> adapter fallback (ADR-007 §2): if the own pipeline fails to load for a media reason
// (a codec it does not carry, a demux error), the format rebuilds once with the mpegts.js adapter.
// Network errors do not fall back: the adapter would fail the same way, and the session's retry
// policy (ADR-005 §3) handles them. The switch is reported as a non-fatal `pipelineFallback`.

import { createError, createEventBus, isOtterError, type Unsubscribe } from '@otter-player/core';
import type { Engine, EngineEvents } from '@otter-player/media';

const EVENTS = {
  'tracks-change': true,
  'quality-change': true,
  'latency-change': true,
  'first-segment': true,
  bandwidth: true,
  'text-cues': true,
  error: true,
} as const satisfies Record<keyof EngineEvents, true>;

type SeekToLive = { seekToLive?(): void };

export function withAdapterFallback(primary: Engine & SeekToLive, createFallback: () => Engine & SeekToLive): Engine & { seekToLive(): void; readonly usingFallback: boolean } {
  const bus = createEventBus<EngineEvents>();
  let current: Engine & SeekToLive = primary;
  let usingFallback = false;
  let forwards: Unsubscribe[] = [];

  const forward = (engine: Engine): void => {
    for (const off of forwards) off();
    forwards = (Object.keys(EVENTS) as (keyof EngineEvents)[]).map((e) => engine.on(e, (p) => bus.emit(e, p as never)));
  };
  forward(primary);

  return {
    get formatId() {
      return current.formatId;
    },
    get tracks() {
      return current.tracks;
    },
    get latency() {
      return current.latency;
    },
    get mms() {
      return current.mms;
    },
    get usingFallback() {
      return usingFallback;
    },
    async load() {
      try {
        await primary.load();
      } catch (err) {
        const error = isOtterError(err) ? err : undefined;
        if (error === undefined || error.type === 'network' || error.details === 'unsupportedSource') throw err;
        primary.destroy();
        usingFallback = true;
        current = createFallback();
        forward(current);
        bus.emit(
          'error',
          createError({ type: 'other', details: 'pipelineFallback', fatal: false, recoverable: true, message: `own pipeline: ${error.details}${err instanceof Error ? ` (${err.message})` : ""}; using the adapter`, cause: error }),
        );
        await current.load();
      }
    },
    selectQuality: (id) => current.selectQuality(id),
    // Every optional Engine method goes to whichever engine is active (608 caption selection on
    // the pipeline, audio tracks on the adapter, ...).
    selectTextTrack: (id) => current.selectTextTrack?.(id),
    selectAudioTrack: (id) => current.selectAudioTrack?.(id),
    thumbnails: () => current.thumbnails?.() ?? null,
    seekToLive: () => current.seekToLive?.(),
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      for (const off of forwards) off();
      forwards = [];
      current.destroy();
      bus.clear();
    },
  };
}
