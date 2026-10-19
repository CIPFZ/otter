// Derived from mpegts.js@791bac89e2ea8cbebe7f7ba247c3b342c09418cc src/player/live-latency-chaser.ts, Apache-2.0
// Derived from mpegts.js@791bac89e2ea8cbebe7f7ba247c3b342c09418cc src/player/live-latency-synchronizer.ts, Apache-2.0
// Derived from mpegts.js@791bac89e2ea8cbebe7f7ba247c3b342c09418cc src/player/startup-stall-jumper.ts, Apache-2.0
//
// Copyright (C) 2023 zheng qian. All Rights Reserved. Licensed under the Apache License, Version
// 2.0. The three upstream controllers as pure decision functions over a playback sample (no
// element, no events): the caller applies the returned seek / rate. Thresholds are upstream's
// defaults (src/config.js).

export interface LiveSample {
  readonly currentTime: number;
  readonly paused: boolean;
  /** Buffered ranges, seconds, ascending. */
  readonly buffered: readonly (readonly [number, number])[];
  readonly playbackRate: number;
  /** HTMLMediaElement.readyState. */
  readonly readyState: number;
}

export interface LatencyConfig {
  /** liveBufferLatencyMaxLatency: chase (seek) when buffered ahead exceeds this. */
  readonly maxLatency: number;
  /** liveBufferLatencyMinRemain: seek to bufferEnd - minRemain. */
  readonly minRemain: number;
  /** liveSyncMaxLatency: speed up above this latency. */
  readonly syncMaxLatency: number;
  /** liveSyncTargetLatency: back to 1x at or below this. */
  readonly syncTargetLatency: number;
  /** liveSyncPlaybackRate, clamped to 1..2. */
  readonly syncPlaybackRate: number;
  /** liveBufferLatencyChasingOnPaused. */
  readonly chaseOnPaused: boolean;
}

export const MPEGTS_LIVE_DEFAULTS: LatencyConfig = {
  maxLatency: 1.5,
  minRemain: 0.5,
  syncMaxLatency: 1.2,
  syncTargetLatency: 0.8,
  syncPlaybackRate: 1.2,
  chaseOnPaused: false,
};

const bufferEnd = (s: LiveSample): number | undefined => s.buffered.at(-1)?.[1];

/** LiveLatencyChaser._chaseLiveLatency: seek target when too far behind, else undefined. */
export function chaseLatency(s: LiveSample, c: LatencyConfig): number | undefined {
  const end = bufferEnd(s);
  if (end === undefined || (!c.chaseOnPaused && s.paused)) return undefined;
  if (end > c.maxLatency && end - s.currentTime > c.maxLatency) return end - c.minRemain;
  return undefined;
}

/** LiveLatencySynchronizer._onMediaTimeUpdate: new playbackRate, or undefined to keep it. */
export function syncRate(s: LiveSample, c: LatencyConfig): number | undefined {
  const end = bufferEnd(s);
  const latency = end === undefined ? 0 : end - s.currentTime;
  if (latency > c.syncMaxLatency) return Math.min(2, Math.max(1, c.syncPlaybackRate));
  if (latency > c.syncTargetLatency) return undefined;
  return s.playbackRate !== 1 && s.playbackRate !== 0 ? 1 : undefined;
}

/**
 * StartupStallJumper._detectAndFixStuckPlayback: playhead before the first buffered range while
 * stalled or not yet playable -> seek to the range start.
 */
export function jumpStartupStall(s: LiveSample, stalled: boolean, canPlayReceived: boolean): number | undefined {
  const first = s.buffered[0];
  if (!(stalled || !canPlayReceived || s.readyState < 2)) return undefined;
  return first !== undefined && s.currentTime < first[0] ? first[0] : undefined;
}
