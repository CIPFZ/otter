// LiveController (SPEC §7, ADR-007 §3): keeps a live stream near the edge. Each sample (timeupdate
// / buffer change) returns at most one action for the engine to apply. The decision rules are
// mpegts.js' latency chaser, rate synchroniser and startup-stall jumper (L3, vendor/mpegts.js);
// this adds Otter's policy: the target latency, respecting a user-chosen rate, back-to-live and an
// explainable reason on every action.

import { chaseLatency, jumpStartupStall, MPEGTS_LIVE_DEFAULTS, syncRate, type LatencyConfig, type LiveSample } from '../vendor/mpegts.js/live.js';

export type { LiveSample } from '../vendor/mpegts.js/live.js';

export interface LiveControllerOptions {
  /**
   * Latency (s, buffer end minus playhead) to hold. Chasing seeks when latency exceeds
   * `targetLatency + 1`, the rate sync speeds up above `targetLatency + 0.4`.
   */
  readonly targetLatency?: number;
  /** Playback rate used to catch up (1..2). */
  readonly catchUpRate?: number;
}

export type LiveAction =
  | { readonly type: 'seek'; readonly to: number; readonly reason: 'chase' | 'startup-stall' | 'seek-to-live' }
  | { readonly type: 'rate'; readonly rate: number; readonly reason: 'catch-up' | 'on-target' };

export interface LiveController {
  /** Latency (s) of the last sample, undefined before buffered media. */
  readonly latency: number | undefined;
  readonly targetLatency: number;
  sample(s: LiveSample, events?: { readonly stalled?: boolean; readonly canPlay?: boolean }): LiveAction | undefined;
  /** The user picked a rate: stop adjusting it until `releaseRate()` (or a back-to-live). */
  holdRate(): void;
  releaseRate(): void;
  /** Back to live: the seek target for the current buffer, undefined without media. */
  seekToLive(s: LiveSample): LiveAction | undefined;
}

export function createLiveController(options: LiveControllerOptions = {}): LiveController {
  const target = Math.max(0.3, options.targetLatency ?? 1);
  const config: LatencyConfig = {
    ...MPEGTS_LIVE_DEFAULTS,
    maxLatency: target + 1,
    minRemain: target,
    syncMaxLatency: target + 0.4,
    syncTargetLatency: target,
    syncPlaybackRate: Math.min(2, Math.max(1, options.catchUpRate ?? 1.2)),
  };
  let latency: number | undefined;
  let rateHeld = false;
  let canPlay = false;
  // The rate we set; anything else on the element was set by someone else (the user).
  let ownRate = 1;

  return {
    get latency() {
      return latency;
    },
    targetLatency: target,
    sample(s, events = {}) {
      if (events.canPlay === true) canPlay = true;
      const end = s.buffered.at(-1)?.[1];
      latency = end === undefined ? undefined : Math.max(0, end - s.currentTime);
      const jump = jumpStartupStall(s, events.stalled === true, canPlay);
      if (jump !== undefined) return { type: 'seek', to: jump, reason: 'startup-stall' };
      const chase = chaseLatency(s, config);
      if (chase !== undefined) return { type: 'seek', to: chase, reason: 'chase' };
      // A rate we did not set means the user chose one: leave it alone (ADR-007 §3).
      if (s.playbackRate !== ownRate) rateHeld = true;
      if (rateHeld || s.paused) return undefined;
      const rate = syncRate(s, config);
      if (rate === undefined || rate === s.playbackRate) return undefined;
      ownRate = rate;
      return { type: 'rate', rate, reason: rate > 1 ? 'catch-up' : 'on-target' };
    },
    holdRate() {
      rateHeld = true;
    },
    releaseRate() {
      rateHeld = false;
    },
    seekToLive(s) {
      const end = s.buffered.at(-1)?.[1];
      if (end === undefined) return undefined;
      rateHeld = false;
      ownRate = s.playbackRate;
      return { type: 'seek', to: Math.max(s.buffered.at(-1)?.[0] ?? 0, end - target), reason: 'seek-to-live' };
    },
  };
}
