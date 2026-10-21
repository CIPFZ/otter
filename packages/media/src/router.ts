// Deterministic routing and fallback chain (SPEC §5.2, ADR-003 §4). Same inputs, same decision;
// every candidate that is considered leaves a RouteStep so `explain()` shows why.

import { createError, type RouteExplanation, type RouteStep } from '@otter-player/core';
import type { BackendKind } from './backend.js';
import type { Capabilities } from './capabilities.js';
import type { Decoder } from './decoder.js';
import type { FormatPlugin } from './format.js';
import type { Source } from './source.js';

export interface FallbackStep {
  readonly backend: BackendKind;
  /** Only for the webcodecs backend: hardware WebCodecs first, then WASM software decoding. */
  readonly decoder?: 'webcodecs' | 'wasm';
}

const WEBCODECS: FallbackStep = { backend: 'webcodecs', decoder: 'webcodecs' };
const WASM: FallbackStep = { backend: 'webcodecs', decoder: 'wasm' };
const MSE: FallbackStep = { backend: 'mse' };
const NATIVE: FallbackStep = { backend: 'native' };

/** SPEC §5.2 step 4: `webcodecs -> wasm -> mse -> native`. */
export const FALLBACK_CHAIN: readonly FallbackStep[] = [WEBCODECS, WASM, MSE, NATIVE];

export interface RoutePolicy {
  readonly preferBackend?: BackendKind;
  readonly forbidBackend?: readonly BackendKind[];
  /** Host needs manual quality switching (forces MSE/MMS over native HLS on iPhone). */
  readonly needsQualitySwitch?: boolean;
}

export interface RouteDecision {
  readonly format: FormatPlugin;
  readonly step: FallbackStep;
  /** Steps still available if this one fails, in order. */
  readonly remaining: readonly FallbackStep[];
  readonly explanation: RouteExplanation;
}

export interface Router {
  /** Throws `noFormat` / `noRoute` (fatal) when nothing can play the source. */
  select(source: Source, caps: Capabilities, policy?: RoutePolicy): RouteDecision;
  /** Next decision after `failed` failed for `reason`; null when the chain is exhausted. */
  fallback(failed: RouteDecision, reason: string): RouteDecision | null;
  /** Appends a detail to the latest explanation (e.g. backend-mse MMS / AirPlay handling). */
  annotate(step: RouteStep): void;
  /** Explanation of the latest decision, also emitted as the `route` QoE event. */
  explain(): RouteExplanation | null;
}

export interface RouterOptions {
  readonly formats: readonly FormatPlugin[];
  /** Backend kinds that have a registered factory. */
  readonly backends: readonly BackendKind[];
  readonly decoders?: readonly Decoder[];
}

/** Label used in RouteStep / explanation: the WASM decoder step shows as `wasm`. */
export const stepLabel = (step: FallbackStep): string => (step.decoder === 'wasm' ? 'wasm' : step.backend);

const HEVC = /(^|[\s,"])(hvc1|hev1)\./;

function initialOrder(format: FormatPlugin, source: Source, caps: Capabilities, policy: RoutePolicy): {
  order: readonly FallbackStep[];
  reason: string;
} {
  const hevcUnsupported =
    HEVC.test(source.codecs ?? '') &&
    !Object.entries(caps.codecs).some(([type, info]) => HEVC.test(type) && info.supported);
  if (hevcUnsupported) return { order: FALLBACK_CHAIN, reason: 'HEVC source without HEVC decoding support' };

  // A format that cannot feed MSE or native (format-file: local files) gets the WebCodecs steps
  // first, on every platform.
  const fed = new Set(format.backends(source, caps));
  if (!fed.has('mse') && !fed.has('native')) return { order: FALLBACK_CHAIN, reason: 'format only feeds WebCodecs' };
  // The host asks for WebCodecs (frame-accurate seeking, GPU surface, multi-view): the whole chain,
  // so its failure still ends on MSE / native.
  if (policy.preferBackend === 'webcodecs' && fed.has('webcodecs')) return { order: FALLBACK_CHAIN, reason: 'WebCodecs preferred by policy: full chain' };

  // iPhone: no MediaSource; ManagedMediaSource on iOS 17.1+, only native HLS before that.
  const iPhone = !caps.mediaSource && (caps.managedMediaSource || caps.nativeHls);
  if (iPhone && format.id === 'hls' && source.drm === undefined && policy.needsQualitySwitch !== true) {
    return { order: [NATIVE, MSE], reason: 'iPhone HLS without DRM or quality switching: native first' };
  }
  if (iPhone) return { order: [MSE, NATIVE], reason: 'iPhone: DRM, quality switching or non-HLS needs ManagedMediaSource' };
  return { order: [MSE, NATIVE], reason: 'default: MSE first' };
}

export function createRouter(options: RouterOptions): Router {
  const registered = new Set(options.backends);
  const hasWasmDecoder = (options.decoders ?? []).some((d) => d.id.startsWith('wasm'));
  let last: RouteExplanation | null = null;

  const rejection = (
    step: FallbackStep,
    format: FormatPlugin,
    fed: ReadonlySet<BackendKind>,
    caps: Capabilities,
    policy: RoutePolicy,
  ): string | null => {
    if (policy.forbidBackend?.includes(step.backend) === true) return 'forbidden by policy';
    if (!fed.has(step.backend)) return `format ${format.id} cannot feed ${step.backend} for this source`;
    if (!registered.has(step.backend)) return 'backend not registered';
    if (step.backend === 'mse' && !caps.mediaSource && !caps.managedMediaSource) return 'no MediaSource / ManagedMediaSource';
    if (step.decoder === 'webcodecs' && !caps.webCodecs) return 'no WebCodecs';
    if (step.decoder === 'wasm' && !hasWasmDecoder) return 'no WASM decoder registered';
    return null;
  };

  const fail = (details: 'noFormat' | 'noRoute', message: string, explanation: RouteExplanation): never => {
    last = explanation;
    throw createError({ type: 'media', details, fatal: true, recoverable: false, message });
  };

  return {
    select(source, caps, policy = {}) {
      const steps: RouteStep[] = [];

      let format: FormatPlugin | undefined;
      let best = 0;
      for (const f of options.formats) {
        const score = Math.min(1, Math.max(0, f.probe(source, caps)));
        steps.push({ candidate: `format:${f.id}`, outcome: 'rejected', reason: `probe ${score}` });
        if (score > best) {
          best = score;
          format = f;
        }
      }
      if (format === undefined) {
        return fail('noFormat', 'no format plugin can play this source', { format: null, backend: null, steps });
      }
      const winner = steps.findIndex((s) => s.candidate === `format:${format.id}`);
      steps[winner] = { candidate: `format:${format.id}`, outcome: 'selected', reason: `probe ${best}` };

      const { order, reason } = initialOrder(format, source, caps, policy);
      steps.push({ candidate: 'platform', outcome: 'selected', reason });

      const fed = new Set(format.backends(source, caps));
      let feasible: FallbackStep[] = [];
      for (const step of order) {
        const rejected = rejection(step, format, fed, caps, policy);
        if (rejected === null) feasible.push(step);
        else steps.push({ candidate: stepLabel(step), outcome: 'rejected', reason: rejected });
      }

      const prefer = policy.preferBackend;
      const preferred = prefer === undefined ? -1 : feasible.findIndex((s) => s.backend === prefer);
      if (preferred > 0) {
        const promoted = feasible[preferred] as FallbackStep;
        feasible = [promoted, ...feasible.filter((_, i) => i !== preferred)];
      }

      const chosen = feasible[0];
      if (chosen === undefined) {
        return fail('noRoute', `no backend can play this ${format.id} source`, { format: format.id, backend: null, steps });
      }
      steps.push({
        candidate: stepLabel(chosen),
        outcome: 'selected',
        reason: preferred > 0 ? 'preferred by policy' : 'first feasible candidate',
      });
      const explanation: RouteExplanation = { format: format.id, backend: stepLabel(chosen), steps };
      last = explanation;
      return { format, step: chosen, remaining: feasible.slice(1), explanation };
    },

    fallback(failed, reason) {
      // Keep details annotated onto the failed decision (e.g. MMS handling) in the history.
      const history =
        last !== null && last.backend === stepLabel(failed.step) && last.steps.length >= failed.explanation.steps.length
          ? last.steps
          : failed.explanation.steps;
      const steps: RouteStep[] = [...history, { candidate: stepLabel(failed.step), outcome: 'failed', reason }];
      const [next, ...rest] = failed.remaining;
      if (next === undefined) {
        last = { format: failed.format.id, backend: null, steps };
        return null;
      }
      steps.push({ candidate: stepLabel(next), outcome: 'selected', reason: `fallback after ${stepLabel(failed.step)}` });
      const explanation: RouteExplanation = { format: failed.format.id, backend: stepLabel(next), steps };
      last = explanation;
      return { format: failed.format, step: next, remaining: rest, explanation };
    },

    annotate(step) {
      if (last !== null) last = { ...last, steps: [...last.steps, step] };
    },

    explain: () => last,
  };
}
