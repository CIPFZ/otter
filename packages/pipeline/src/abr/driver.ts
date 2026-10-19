// Engine-side ABR glue (ADR-005 §1): one per playback. Adapters report downloads and appends, and
// ask for a decision with the engine's own level list; the driver keeps the estimator, segment
// counters and ladder ordering so hls.js and Shaka integrations stay thin and identical.

import { type AbrController, type AbrDecision, type AbrLevel, type BufferState } from './abr.js';
import { createDefaultAbrController } from './defaults.js';
import { EwmaBandwidthEstimator, type BandwidthEstimate } from '../vendor/hls.js/ewma.js';

export interface AbrSnapshot {
  /** Engine levels in engine order; the driver sorts by bitrate internally. */
  readonly levels: readonly AbrLevel[];
  /** Engine index of the level currently loading, -1 if unknown. */
  readonly current: number;
  /** Seconds buffered ahead of the playhead. */
  readonly bufferLevel: number;
  readonly segmentDuration: number;
  readonly live: boolean;
  readonly lowLatency: boolean;
  readonly bufferTarget: number;
}

export interface AbrEngineDecision extends AbrDecision {
  /** Engine index of the chosen level (the decision's `level` is an index in bitrate order). */
  readonly engineLevel: number;
  /** The chosen level itself, so reasons and stats can name it. */
  readonly chosen: AbrLevel | undefined;
  readonly bandwidth: BandwidthEstimate;
}

export interface AbrDriver {
  readonly controller: AbrController;
  /** One media download (ms of transfer, bytes). */
  sampleDownload(durationMs: number, bytes: number, ttfbMs?: number): void;
  segmentAppended(): void;
  /** Seek or new load: rules restart, segment counters reset; the bandwidth estimate is kept. */
  reset(): void;
  /** Engine index that was actually applied (manual switch, emergency abandon, ...). */
  applied(engineLevel: number, levels: readonly AbrLevel[]): void;
  decide(snapshot: AbrSnapshot): AbrEngineDecision;
  readonly canEstimate: boolean;
  readonly bandwidth: BandwidthEstimate;
  readonly lastDecision: AbrEngineDecision | undefined;
}

export interface AbrDriverOptions {
  readonly controller?: AbrController;
  /** Bandwidth assumed before the first sample (hls.js abrEwmaDefaultEstimate is 500 kbps). */
  readonly defaultEstimate?: number;
  readonly halfLife?: { readonly slow: number; readonly fast: number };
  readonly now?: () => number;
}

/** Below this, the buffer counts as empty (dash.js BUFFER_EMPTY). */
const EMPTY_BUFFER_S = 0.5;

function bufferStateOf(bufferLevel: number, segmentDuration: number): BufferState {
  if (bufferLevel < EMPTY_BUFFER_S) return 'empty';
  // dash.js BUFFER_LOADED: at least one segment of media ahead.
  return bufferLevel >= Math.max(segmentDuration, EMPTY_BUFFER_S) ? 'loaded' : 'loading';
}

/** Ascending-by-bitrate order: sorted[i] = engine index. */
const orderOf = (levels: readonly AbrLevel[]): number[] =>
  levels.map((_, i) => i).sort((a, b) => (levels[a] as AbrLevel).bitrate - (levels[b] as AbrLevel).bitrate);

export function createAbrDriver(options: AbrDriverOptions = {}): AbrDriver {
  const controller = options.controller ?? createDefaultAbrController();
  const now = options.now ?? (() => Date.now());
  const estimator = new EwmaBandwidthEstimator(options.halfLife?.slow ?? 15, options.halfLife?.fast ?? 4, options.defaultEstimate ?? 500_000);
  let appended = 0;
  let last: AbrEngineDecision | undefined;

  return {
    controller,
    sampleDownload(durationMs, bytes, ttfbMs) {
      estimator.sample(durationMs, bytes);
      if (ttfbMs !== undefined && ttfbMs >= 0) estimator.sampleTtfb(ttfbMs);
    },
    segmentAppended() {
      appended++;
    },
    reset() {
      appended = 0;
      controller.reset();
    },
    applied(engineLevel, levels) {
      const sortedIndex = orderOf(levels).indexOf(engineLevel);
      if (sortedIndex >= 0) controller.levelApplied(sortedIndex);
    },
    decide(s) {
      const order = orderOf(s.levels);
      const sorted = order.map((i) => s.levels[i] as AbrLevel);
      const bandwidth = estimator.bandwidth;
      const decision = controller.decide({
        levels: sorted,
        current: order.indexOf(s.current),
        bufferLevel: s.bufferLevel,
        bufferState: bufferStateOf(s.bufferLevel, s.segmentDuration),
        throughput: estimator.canEstimate ? bandwidth.estimate : Number.NaN,
        latencyMs: estimator.ttfb,
        segmentDuration: s.segmentDuration,
        live: s.live,
        lowLatency: s.lowLatency,
        segmentsAppended: appended,
        bufferTarget: s.bufferTarget,
        now: now(),
      });
      const engineLevel = order[decision.level] ?? -1;
      const chosen = s.levels[engineLevel];
      const reason = chosen === undefined ? decision.reason : `${decision.reason} -> ${chosen.id} @ ${Math.round(chosen.bitrate / 1000)} kbps`;
      last = { ...decision, reason, engineLevel, chosen, bandwidth };
      return last;
    },
    get canEstimate() {
      return estimator.canEstimate;
    },
    get bandwidth() {
      return estimator.bandwidth;
    },
    get lastDecision() {
      return last;
    },
  };
}
