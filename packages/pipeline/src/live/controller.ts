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
  | { readonly type: 'rate'; readonly rate: number; readonly reason: 'catch-up' | 'on-target' | 'user-seek' };

export interface LiveController {
  /** Latency (s) of the last sample, undefined before buffered media. */
  readonly latency: number | undefined;
  readonly targetLatency: number;
  /** A new latency to hold (HLS: HOLD-BACK of a newly loaded playlist); thresholds follow it. */
  setTargetLatency(seconds: number): void;
  sample(s: LiveSample, events?: { readonly stalled?: boolean; readonly canPlay?: boolean }): LiveAction | undefined;
  /**
   * The element is seeking to `time` (its `seeking` event). A seek the controller did not ask for,
   * once playable, is the user's (DVR): no chasing, no rate sync, no stall jump until back to live
   * or until the playhead is near the target again.
   */
  seeking(time: number): void;
  /** The user picked a rate: stop adjusting it until `releaseRate()` (or a back-to-live). */
  holdRate(): void;
  releaseRate(): void;
  /** Back to live: the seek target for the current buffer, undefined without media. */
  seekToLive(s: LiveSample): LiveAction | undefined;
}

const configFor = (target: number, catchUpRate: number | undefined): LatencyConfig => ({
  ...MPEGTS_LIVE_DEFAULTS,
  maxLatency: target + 1,
  minRemain: target,
  syncMaxLatency: target + 0.4,
  syncTargetLatency: target,
  syncPlaybackRate: Math.min(2, Math.max(1, catchUpRate ?? 1.2)),
});

export function createLiveController(options: LiveControllerOptions = {}): LiveController {
  let target = Math.max(0.3, options.targetLatency ?? 1);
  let config = configFor(target, options.catchUpRate);
  let latency: number | undefined;
  let rateHeld = false;
  let canPlay = false;
  // The rate we set; anything else on the element was set by someone else (the user).
  let ownRate = 1;
  /** The user seeked behind the target (DVR): keep their position. */
  let held = false;
  /** Where our last seek action went: its `seeking` event is not the user's. */
  let ownSeek: number | undefined;
  const seek = (to: number, reason: 'chase' | 'startup-stall' | 'seek-to-live'): LiveAction => {
    ownSeek = to;
    return { type: 'seek', to, reason };
  };

  return {
    get latency() {
      return latency;
    },
    get targetLatency() {
      return target;
    },
    setTargetLatency(seconds) {
      target = Math.max(0.3, seconds);
      config = configFor(target, options.catchUpRate);
    },
    sample(s, events = {}) {
      if (events.canPlay === true) canPlay = true;
      const end = s.edge ?? s.buffered.at(-1)?.[1];
      latency = end === undefined ? undefined : Math.max(0, end - s.currentTime);
      if (held && latency !== undefined && latency <= config.maxLatency) held = false;
      if (held) {
        // Behind on purpose: play at normal speed where the user put it.
        if (s.playbackRate !== ownRate || ownRate === 1) return undefined;
        ownRate = 1;
        return { type: 'rate', rate: 1, reason: 'user-seek' };
      }
      // With an edge (HLS) the engine loads what is missing: the jump is for startup only.
      const jump = s.edge !== undefined && canPlay ? undefined : jumpStartupStall(s, events.stalled === true, canPlay);
      if (jump !== undefined) return seek(jump, 'startup-stall');
      const chase = chaseLatency(s, config);
      if (chase !== undefined) return seek(chase, 'chase');
      // A rate we did not set means the user chose one: leave it alone (ADR-007 §3).
      if (s.playbackRate !== ownRate) rateHeld = true;
      if (rateHeld || s.paused) return undefined;
      const rate = syncRate(s, config);
      if (rate === undefined || rate === s.playbackRate) return undefined;
      ownRate = rate;
      return { type: 'rate', rate, reason: rate > 1 ? 'catch-up' : 'on-target' };
    },
    seeking(time) {
      if (ownSeek !== undefined && Math.abs(time - ownSeek) < 0.05) {
        ownSeek = undefined;
        return;
      }
      if (canPlay) held = true;
    },
    holdRate() {
      rateHeld = true;
    },
    releaseRate() {
      rateHeld = false;
    },
    seekToLive(s) {
      const end = s.edge ?? s.buffered.at(-1)?.[1];
      if (end === undefined) return undefined;
      rateHeld = false;
      held = false;
      ownRate = s.playbackRate;
      // Not before the buffered start (FLV / TS); with an edge (HLS) the engine loads what is missing.
      const floor = s.edge === undefined ? (s.buffered.at(-1)?.[0] ?? 0) : 0;
      return seek(Math.max(floor, end - target), 'seek-to-live');
    },
  };
}
