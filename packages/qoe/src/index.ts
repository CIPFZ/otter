// QoE collector (SPEC §10, §14.2): aggregates core QoE events into the snapshot consumed by the
// stats panel and analytics plugins. `createQoePlugin` mirrors the snapshot into the store so UI
// reads it like any other state (UI never subscribes to engine internals).

import {
  createEventBus,
  type OtterError,
  type Plugin,
  type QoeHook,
  type RouteExplanation,
  type StoreSlice,
  type Unsubscribe,
} from '@otter-player/core';

export interface QoeSnapshot {
  /** Time to first frame, ms. */
  readonly ttff: number | null;
  /** Time to first segment, ms. */
  readonly firstSegmentMs: number | null;
  readonly backend: string | null;
  readonly format: string | null;
  readonly codec: string | null;
  readonly rebufferCount: number;
  /** Total rebuffering, ms. */
  readonly rebufferDuration: number;
  readonly qualitySwitches: number;
  readonly lastQualitySwitch: { readonly from: string | null; readonly to: string; readonly mode: 'auto' | 'manual' } | null;
  readonly errors: number;
  readonly lastError: Pick<OtterError, 'type' | 'details' | 'fatal'> | null;
  /** bits per second */
  readonly bandwidth: number | null;
  /** Seconds behind the live edge. */
  readonly latency: number | null;
  readonly targetLatency: number | null;
  readonly droppedFrames: number;
  readonly totalFrames: number;
  /** Accumulated watch time at the last exit, seconds. */
  readonly watched: number;
  readonly route: RouteExplanation | null;
}

export const EMPTY_QOE: QoeSnapshot = {
  ttff: null,
  firstSegmentMs: null,
  backend: null,
  format: null,
  codec: null,
  rebufferCount: 0,
  rebufferDuration: 0,
  qualitySwitches: 0,
  lastQualitySwitch: null,
  errors: 0,
  lastError: null,
  bandwidth: null,
  latency: null,
  targetLatency: null,
  droppedFrames: 0,
  totalFrames: 0,
  watched: 0,
  route: null,
};

export interface QoeCollector {
  snapshot(): QoeSnapshot;
  onChange(listener: (snapshot: QoeSnapshot) => void): Unsubscribe;
  reset(): void;
  destroy(): void;
}

interface QoeCollectorEvents {
  change: QoeSnapshot;
}

export function createQoeCollector(hook: QoeHook): QoeCollector {
  const bus = createEventBus<QoeCollectorEvents>();
  let snap: QoeSnapshot = EMPTY_QOE;
  const update = (patch: Partial<QoeSnapshot>): void => {
    snap = { ...snap, ...patch };
    bus.emit('change', snap);
  };

  // Session boundary: the playback session emits `exit` when a load ends (unload or a new load);
  // the first `route` after that starts a fresh snapshot. Fallback routes extend the current one.
  let ended = true;

  const offs: Unsubscribe[] = [
    hook.on('route', (route) => {
      const base = ended ? EMPTY_QOE : snap;
      ended = false;
      snap = base;
      update({ route, backend: route.backend, format: route.format });
    }),
    hook.on('startup', (s) =>
      update({ ttff: s.ttff, firstSegmentMs: s.firstSegmentMs ?? null, backend: s.backend, format: s.format, codec: s.codec ?? null }),
    ),
    hook.on('rebuffer', (r) => update({ rebufferCount: snap.rebufferCount + 1, rebufferDuration: snap.rebufferDuration + (r.duration ?? 0) })),
    hook.on('quality-switch', (q) =>
      update({ qualitySwitches: snap.qualitySwitches + 1, lastQualitySwitch: { from: q.from, to: q.to, mode: q.mode } }),
    ),
    hook.on('error', ({ error }) =>
      update({ errors: snap.errors + 1, lastError: { type: error.type, details: error.details, fatal: error.fatal } }),
    ),
    hook.on('bandwidth', (b) => update({ bandwidth: b.estimate })),
    hook.on('latency', (l) => update({ latency: l.latency, targetLatency: l.target ?? snap.targetLatency })),
    hook.on('dropped-frames', (d) => update({ droppedFrames: d.dropped, totalFrames: d.total })),
    hook.on('exit', (e) => {
      ended = true;
      update({ watched: e.watched });
    }),
  ];

  return {
    snapshot: () => snap,
    onChange: (listener) => bus.on('change', (s) => listener(s)),
    reset() {
      update(EMPTY_QOE);
    },
    destroy() {
      for (const off of offs) off();
      bus.clear();
    },
  };
}

export interface QoeState {
  readonly qoe: QoeSnapshot;
}

export const QOE_SLICE: StoreSlice<QoeState> = { id: 'qoe', initialState: { qoe: EMPTY_QOE } };

/** Mirrors the collector snapshot into the store (`qoe` key, from QOE_SLICE). */
export function createQoePlugin<S extends QoeState, A extends object>(): Plugin<S, A> {
  let collector: QoeCollector | undefined;
  let off: Unsubscribe | undefined;
  return {
    id: 'qoe',
    install(ctx) {
      collector = createQoeCollector(ctx.qoe);
      off = collector.onChange((qoe) => ctx.store.setState({ qoe } as Partial<S>));
    },
    uninstall() {
      off?.();
      collector?.destroy();
      collector = undefined;
    },
  };
}
