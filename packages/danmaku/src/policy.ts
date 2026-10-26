// Which renderer draws the danmaku (ADR-012 §5): Canvas 2D by default; WebGL (atlas, one draw
// call) when the stage is dense or Canvas drawing gets slow; the OffscreenCanvas Worker when the
// page's own work leaves frames late, or WebGL turns out no cheaper on the main thread. Decided over a window of drawn frames, with hysteresis, and
// explained like router.explain().

export type RendererKind = 'canvas2d' | 'webgl' | 'worker';

/** One drawn frame. */
export interface FrameSample {
  /** Comments on the stage. */
  readonly onStage: number;
  /** ms in the engine's frame (placement + renderer draw) on the main thread. */
  readonly drawMs: number;
  /** ms since the previous rAF (the page's frame pacing). */
  readonly intervalMs: number;
}

/** The thresholds (ADR-012 §5). */
export const POLICY = {
  /** Frames a decision looks at. */
  window: 60,
  /** Up to WebGL: average comments on stage at least this ... */
  denseOnStage: 120,
  /** ... or the 90th percentile of the main-thread frame cost at least this (ms). */
  slowDrawMs: 4,
  /** To the Worker: frame interval p90 at least this (ms) while our own cost is small ... */
  busyIntervalMs: 25,
  /** ... and the stage not nearly empty. */
  busyMinOnStage: 40,
  /** Back to Canvas 2D: average on stage at most this over `quietFrames`, nothing busy. */
  sparseOnStage: 40,
  quietFrames: 600,
  /** No switch within this long of the last one (ms). */
  holdMs: 5000,
} as const;

export interface Decision {
  readonly to: RendererKind;
  readonly reason: string;
  /** Not to be chosen again on this page (it was measured slower here). */
  readonly reject?: RendererKind;
}

const p90 = (xs: readonly number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] ?? 0;
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/**
 * The renderer for the next frames given the recent ones (newest last), or undefined to stay.
 * `available`: what this page can run (WebGL2 here / in a Worker).
 */
export function decide(current: RendererKind, recent: readonly FrameSample[], sinceSwitchMs: number, available: ReadonlySet<RendererKind>): Decision | undefined {
  if (sinceSwitchMs < POLICY.holdMs || recent.length < POLICY.window) return undefined;
  const w = recent.slice(-POLICY.window);
  const onStage = mean(w.map((f) => f.onStage));
  const draw = p90(w.map((f) => f.drawMs));
  const interval = p90(w.map((f) => f.intervalMs));
  // Density first: WebGL is the cheaper way to draw a full stage, whoever is slow.
  if (current === 'canvas2d' && available.has('webgl') && (onStage >= POLICY.denseOnStage || draw >= POLICY.slowDrawMs)) {
    return {
      to: 'webgl',
      reason: onStage >= POLICY.denseOnStage ? `dense: ${Math.round(onStage)} comments on stage (≥ ${POLICY.denseOnStage})` : `Canvas 2D frame cost p90 ${draw.toFixed(1)} ms (≥ ${POLICY.slowDrawMs})`,
    };
  }
  // WebGL no cheaper than the threshold that brought it (some engines' WebGL costs the main
  // thread more than Canvas 2D: CI's macOS WebKit 6 ms a frame): drawing off the main thread, or
  // back to Canvas 2D; WebGL is not tried again here.
  if (current === 'webgl' && draw >= POLICY.slowDrawMs) {
    const why = `WebGL frame cost p90 ${draw.toFixed(1)} ms (≥ ${POLICY.slowDrawMs})`;
    return available.has('worker') ? { to: 'worker', reason: `${why}: drawing off the main thread`, reject: 'webgl' } : { to: 'canvas2d', reason: `${why}: back to Canvas 2D`, reject: 'webgl' };
  }
  const busy = interval >= POLICY.busyIntervalMs && draw < POLICY.slowDrawMs && onStage >= POLICY.busyMinOnStage;
  if (busy && current !== 'worker' && available.has('worker')) {
    return { to: 'worker', reason: `main thread busy: frame interval p90 ${interval.toFixed(1)} ms (≥ ${POLICY.busyIntervalMs}), own cost p90 ${draw.toFixed(1)} ms` };
  }
  if (current !== 'canvas2d' && recent.length >= POLICY.quietFrames) {
    const quiet = recent.slice(-POLICY.quietFrames);
    const sparse = mean(quiet.map((f) => f.onStage));
    if (sparse <= POLICY.sparseOnStage && p90(quiet.map((f) => f.intervalMs)) < POLICY.busyIntervalMs) {
      return { to: 'canvas2d', reason: `sparse: ${Math.round(sparse)} comments on stage over ${POLICY.quietFrames} frames (≤ ${POLICY.sparseOnStage})` };
    }
  }
  return undefined;
}
