// Recovery policy (ADR-005 §3): before a fatal error moves playback down the fallback chain, the
// same backend is rebuilt a bounded number of times with backoff (network errors are rarely
// fixed by another backend). Pure helpers; the session owns timers and state.

import type { OtterError, OtterErrorType } from '@otter-player/core';

export interface RecoveryPolicy {
  /** Same-backend rebuilds per error type before falling back. */
  readonly retries: Readonly<Partial<Record<OtterErrorType, number>>>;
  /** Delay before rebuild number `attempt` (0-based), ms. */
  readonly backoffMs: (attempt: number, error: OtterError) => number;
  /** Errors a rebuild cannot fix: straight to the fallback chain. */
  readonly noRetry: readonly string[];
  /** Healthy playback this long resets the retry counters, ms. */
  readonly resetAfterMs: number;
  /** Playing with media buffered ahead but no playhead progress this long counts as a stall, ms. */
  readonly stallTimeoutMs: number;
  /**
   * Same, before the playhead has moved at all since playback started, ms. WebKit MSE can sit on
   * the first video frame when audio starts before it (RESEARCH §1); a nudge frees it at once.
   */
  readonly startupStallMs: number;
  /** Nudge distance for a stall, seconds (hls.js nudgeOffset is 0.1). */
  readonly nudgeS: number;
}

export const DEFAULT_RECOVERY: RecoveryPolicy = {
  retries: { network: 3, media: 1 },
  backoffMs: (attempt) => 1000 * 2 ** attempt,
  noRetry: [
    'noFormat',
    'noRoute',
    'unsupportedSource',
    'engineUnsupported',
    'mediaSrcNotSupported',
    'manifestIncompatibleCodecsError',
    'capabilityDetectionFailed',
    // WebRTC could not find a path (UDP blocked, unreachable candidates): a new offer will not.
    'iceFailed',
  ],
  resetAfterMs: 30_000,
  stallTimeoutMs: 8_000,
  startupStallMs: 1_500,
  nudgeS: 0.1,
};

export function resolveRecovery(partial: Partial<RecoveryPolicy> = {}): RecoveryPolicy {
  return { ...DEFAULT_RECOVERY, ...partial, retries: { ...DEFAULT_RECOVERY.retries, ...partial.retries } };
}

export interface RetryBudget {
  /** Delay before rebuilding the same backend, or null when the error must fall back. */
  next(error: OtterError, now: number): number | null;
  /** Call while playback progresses; long enough healthy playback resets the counters. */
  healthy(now: number): void;
  reset(): void;
  readonly attempts: Readonly<Partial<Record<OtterErrorType, number>>>;
}

export function createRetryBudget(policy: RecoveryPolicy): RetryBudget {
  let attempts: Partial<Record<OtterErrorType, number>> = {};
  let lastRetryAt = Number.NEGATIVE_INFINITY;
  return {
    next(error, now) {
      if (policy.noRetry.includes(error.details)) return null;
      const used = attempts[error.type] ?? 0;
      const limit = policy.retries[error.type] ?? 0;
      if (used >= limit) return null;
      attempts = { ...attempts, [error.type]: used + 1 };
      lastRetryAt = now;
      return policy.backoffMs(used, error);
    },
    healthy(now) {
      if (now - lastRetryAt >= policy.resetAfterMs && Object.keys(attempts).length > 0) attempts = {};
    },
    reset() {
      attempts = {};
      lastRetryAt = Number.NEGATIVE_INFINITY;
    },
    get attempts() {
      return attempts;
    },
  };
}

export type StallAction = 'none' | 'nudge' | 'escalate';

export interface StallWatchdog {
  /** Feed a sample; returns what to do about a stall. */
  /**
   * `playing`: not paused, ended or seeking. `seeking`: a seek in progress. A seek the nudge
   * started that never completes (no frame decodes there) is still a stall.
   */
  sample(s: {
    readonly now: number;
    readonly currentTime: number;
    readonly playing: boolean;
    readonly bufferAhead: number;
    readonly seeking?: boolean;
    /** A picture was decoded; until then a moving playhead (a gap jump) is not progress. Default true. */
    readonly picture?: boolean;
  }): StallAction;
  reset(): void;
}

/**
 * Playing, with more than half a second buffered ahead, and no progress for stallTimeoutMs:
 * first nudge the playhead, then escalate (the session treats it as a media error).
 */
export function createStallWatchdog(policy: RecoveryPolicy): StallWatchdog {
  let lastTime = Number.NaN;
  let since = Number.NaN;
  let nudged = false;
  let progressed = false;
  /** Where our nudge put the playhead: getting there is not playback progress. */
  let nudgedTo = Number.NaN;
  const reset = (): void => {
    lastTime = Number.NaN;
    since = Number.NaN;
    nudged = false;
    progressed = false;
    nudgedTo = Number.NaN;
  };
  return {
    sample({ now, currentTime, playing: running, bufferAhead, seeking = false, picture = true }) {
      const playing = running || (seeking && nudged);
      if (!playing || bufferAhead < 0.5 || currentTime !== lastTime) {
        const byNudge = nudged && Math.abs(currentTime - nudgedTo) < 1e-3;
        if (currentTime !== lastTime && !Number.isNaN(lastTime) && !byNudge) {
          nudged = false;
          if (playing && picture) progressed = true;
        }
        lastTime = currentTime;
        since = now;
        return 'none';
      }
      if (now - since < (progressed ? policy.stallTimeoutMs : Math.min(policy.startupStallMs, policy.stallTimeoutMs))) return 'none';
      since = now;
      if (!nudged) {
        nudged = true;
        nudgedTo = currentTime + policy.nudgeS;
        return 'nudge';
      }
      return 'escalate';
    },
    reset,
  };
}
