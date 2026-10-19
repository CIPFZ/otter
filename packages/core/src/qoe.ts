// QoE hook (SPEC §4, event set in SPEC §10). Telemetry is built in from day one; the `qoe`
// package and the stats panel consume these events. Payloads are plain data so they can cross a
// Worker boundary unchanged.

import { createEventBus, type EventBus } from './events.js';
import type { OtterError } from './errors.js';

export interface RouteStep {
  /** Backend (or decoder fallback step such as `wasm`) that was considered. */
  readonly candidate: string;
  readonly outcome: 'selected' | 'rejected' | 'failed';
  readonly reason: string;
}

/** Output of `router.explain()` (SPEC §5.2), also carried by the `route` QoE event. */
export interface RouteExplanation {
  readonly format: string | null;
  readonly backend: string | null;
  readonly steps: readonly RouteStep[];
}

export interface QoeEventMap {
  startup: {
    /** Time to first frame from the load action, ms. */
    readonly ttff: number;
    /** Time to the first media segment from the load action, ms. */
    readonly firstSegmentMs?: number;
    readonly backend: string;
    readonly format: string;
    readonly codec?: string;
  };
  rebuffer: {
    /** Media position, seconds. */
    readonly position: number;
    /** Monotonic clock (performance.now), ms. */
    readonly startedAt: number;
    readonly endedAt?: number;
    /** ms */
    readonly duration?: number;
  };
  'quality-switch': {
    readonly from: string | null;
    readonly to: string;
    readonly reason: string;
    readonly mode: 'auto' | 'manual';
  };
  error: {
    readonly error: OtterError;
    /** Remaining fallback path at the time of the error (empty when none is left). */
    readonly fallback: readonly string[];
  };
  bandwidth: {
    /** bits per second */
    readonly estimate: number;
    readonly fast: number;
    readonly slow: number;
    /** The engine's configured default, not a measurement yet (shown as "(est.)"). */
    readonly estimated?: boolean;
  };
  latency: {
    /** seconds behind live edge */
    readonly latency: number;
    readonly target?: number;
  };
  'dropped-frames': {
    readonly dropped: number;
    readonly total: number;
  };
  exit: {
    readonly position: number;
    /** Accumulated watch time, seconds. */
    readonly watched: number;
  };
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
}

export type QoeEventType = keyof QoeEventMap;

export type QoeHook = EventBus<QoeEventMap>;

export function createQoeHook(): QoeHook {
  return createEventBus<QoeEventMap>();
}
