// QoE hook (SPEC §4, event set in SPEC §10). Telemetry is built in from day one; the `qoe`
// package and the stats panel consume these events. Payloads are plain data so they can cross a
// Worker boundary unchanged.

import { createEventBus, type EventBus } from './events.js';
import type { OtterError } from './errors.js';

/** One step of a routing decision: a candidate (format, backend, engine) and what became of it. */
export interface RouteStep {
  /** What was considered (`hls`, `mse`, `hlsjs`, ...). */
  readonly candidate: string;
  /** Selected, rejected before trying, or failed when tried. */
  readonly outcome: 'selected' | 'rejected' | 'failed';
  /** Why, in words (codecs, capabilities, an error). */
  readonly reason: string;
}

/** Output of `router.explain()` (SPEC §5.2), also carried by the `route` QoE event. */
export interface RouteExplanation {
  readonly format: string | null;
  readonly backend: string | null;
  readonly steps: readonly RouteStep[];
}

/** The QoE events (CTA-2066-style metrics) a player emits on its `qoe` hook. */
export interface QoeEventMap {
  /** The first frame showed. */
  startup: {
    /** Time to first frame from the load action, ms. */
    readonly ttff: number;
    /** Time to the first media segment from the load action, ms. */
    readonly firstSegmentMs?: number;
    readonly backend: string;
    readonly format: string;
    readonly codec?: string;
  };
  /** Playback waited for data (one event when it starts, one when it ends). */
  rebuffer: {
    /** Media position, seconds. */
    readonly position: number;
    /** Monotonic clock (performance.now), ms. */
    readonly startedAt: number;
    readonly endedAt?: number;
    /** ms */
    readonly duration?: number;
  };
  /** The quality changed (ABR or the viewer). */
  'quality-switch': {
    readonly from: string | null;
    readonly to: string;
    readonly reason: string;
    readonly mode: 'auto' | 'manual';
  };
  /** An error, with the fallback path left at that time. */
  error: {
    readonly error: OtterError;
    /** Remaining fallback path at the time of the error (empty when none is left). */
    readonly fallback: readonly string[];
  };
  /** A new bandwidth estimate. */
  bandwidth: {
    /** bits per second */
    readonly estimate: number;
    readonly fast: number;
    readonly slow: number;
    /** The engine's configured default, not a measurement yet (shown as "(est.)"). */
    readonly estimated?: boolean;
  };
  /** Live latency, seconds behind the live edge. */
  latency: {
    /** seconds behind live edge */
    readonly latency: number;
    readonly target?: number;
  };
  /** Dropped frames so far. */
  'dropped-frames': {
    readonly dropped: number;
    readonly total: number;
  };
  /** The session ended (unload, destroy): watch time. */
  exit: {
    readonly position: number;
    /** Accumulated watch time, seconds. */
    readonly watched: number;
  };
  /** The routing decision of a load (also explain()'s `route`). */
  route: RouteExplanation;
  /** Window mode changed (SPEC §15); modes are PresentationMode names. */
  'presentation-change': {
    readonly from: string;
    readonly to: string;
    readonly reason?: string;
  };
  /** A mode request was refused or rolled back (ADR-007 §5). */
  'presentation-denied': {
    readonly from: string;
    readonly to: string;
    readonly reason: string;
  };
  /**
   * This player muted itself because another one (another tab of the origin) started playing
   * with sound (SPEC §15, ADR-008 §8). `to`: that player's random instance id.
   */
  'audio-yield': {
    readonly to: string;
  };
}

export type QoeEventType = keyof QoeEventMap;

/** The QoE event bus of a player (`player.qoe`). */
export type QoeHook = EventBus<QoeEventMap>;

/** Creates a QoE hook (createCore makes one). */
export function createQoeHook(): QoeHook {
  return createEventBus<QoeEventMap>();
}
