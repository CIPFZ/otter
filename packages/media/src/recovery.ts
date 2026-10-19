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
  ],
  resetAfterMs: 30_000,
  stallTimeoutMs: 8_000,
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
  sample(s: { readonly now: number; readonly currentTime: number; readonly playing: boolean; readonly bufferAhead: number }): StallAction;
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
  const reset = (): void => {
    lastTime = Number.NaN;
    since = Number.NaN;
    nudged = false;
  };
  return {
    sample({ now, currentTime, playing, bufferAhead }) {
      if (!playing || bufferAhead < 0.5 || currentTime !== lastTime) {
        if (currentTime !== lastTime && !Number.isNaN(lastTime)) nudged = false;
        lastTime = currentTime;
        since = now;
        return 'none';
      }
      if (now - since < policy.stallTimeoutMs) return 'none';
      since = now;
      if (!nudged) {
        nudged = true;
        return 'nudge';
      }
      return 'escalate';
    },
    reset,
  };
}
