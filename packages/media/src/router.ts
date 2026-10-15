// Deterministic routing and fallback chain (SPEC §5.2).

import { notImplemented, type RouteExplanation } from '@otter-player/core';
import type { BackendKind } from './backend';
import type { Capabilities } from './capabilities';
import type { Decoder } from './decoder';
import type { FormatPlugin } from './format';
import type { Source } from './source';

export interface FallbackStep {
  readonly backend: BackendKind;
  /** Only for the webcodecs backend: hardware WebCodecs first, then WASM software decoding. */
  readonly decoder?: 'webcodecs' | 'wasm';
}

/** SPEC §5.2 step 4: `webcodecs -> wasm -> mse -> native`. */
export const FALLBACK_CHAIN: readonly FallbackStep[] = [
  { backend: 'webcodecs', decoder: 'webcodecs' },
  { backend: 'webcodecs', decoder: 'wasm' },
  { backend: 'mse' },
  { backend: 'native' },
];

export interface RoutePolicy {
  readonly preferBackend?: BackendKind;
  readonly forbidBackend?: readonly BackendKind[];
  /** Host needs manual quality switching (forces MSE/MMS over native HLS on iPhone). */
  readonly needsQualitySwitch?: boolean;
}

export interface RouteDecision {
  readonly format: FormatPlugin;
  readonly step: FallbackStep;
  /** Steps still available if this one fails. */
  readonly remaining: readonly FallbackStep[];
  readonly explanation: RouteExplanation;
}

export interface Router {
  select(source: Source, caps: Capabilities, policy?: RoutePolicy): RouteDecision;
  /** Next decision after `failed` failed for `reason`; null when the chain is exhausted. */
  fallback(failed: RouteDecision, reason: string): RouteDecision | null;
  /** Explanation of the latest decision, also emitted as the `route` QoE event. */
  explain(): RouteExplanation | null;
}

export interface RouterOptions {
  readonly formats: readonly FormatPlugin[];
  readonly decoders?: readonly Decoder[];
}

export function createRouter(_options: RouterOptions): Router {
  return {
    select() {
      throw notImplemented('@otter-player/media router.select');
    },
    fallback() {
      throw notImplemented('@otter-player/media router.fallback');
    },
    explain: () => null,
  };
}
