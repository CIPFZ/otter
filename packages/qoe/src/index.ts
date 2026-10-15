// QoE collector (SPEC §10): aggregates core QoE events into the snapshot consumed by the stats
// panel and analytics plugins. M0 empty implementation.

import { notImplemented, type QoeHook, type RouteExplanation } from '@otter-player/core';

export interface QoeSnapshot {
  readonly ttff: number | null;
  readonly backend: string | null;
  readonly format: string | null;
  readonly rebufferCount: number;
  /** Seconds. */
  readonly rebufferDuration: number;
  readonly qualitySwitches: number;
  readonly errors: number;
  /** bits per second */
  readonly bandwidth: number | null;
  readonly latency: number | null;
  readonly droppedFrames: number;
  readonly route: RouteExplanation | null;
}

export interface QoeCollector {
  snapshot(): QoeSnapshot;
  reset(): void;
  destroy(): void;
}

export function createQoeCollector(_hook: QoeHook): QoeCollector {
  return {
    snapshot() {
      throw notImplemented('@otter-player/qoe snapshot');
    },
    reset() {
      throw notImplemented('@otter-player/qoe reset');
    },
    destroy: () => undefined,
  };
}
