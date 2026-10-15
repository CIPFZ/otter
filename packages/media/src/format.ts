// FormatPlugin and Engine (SPEC §5, ADR-003 §3). A FormatPlugin scores a source, declares which
// backends it can feed and produces the Engine (engine adapter or, from M3, the own pipeline).

import type { OtterError, QoeHook, Unsubscribe } from '@otter-player/core';
import type { BackendKind } from './backend.js';
import type { Capabilities } from './capabilities.js';
import type { LoadOptions, Source } from './source.js';
import type { TrackList } from './tracks.js';

export interface EngineContext {
  readonly source: Source;
  readonly options: LoadOptions;
  readonly caps: Capabilities;
  readonly backend: BackendKind;
  readonly qoe: QoeHook;
  /** Element the engine attaches its MediaSource to (engine adapters own MSE in M1). */
  readonly media: HTMLMediaElement;
  /** Use ManagedMediaSource instead of MediaSource (decided by backend-mse, ADR-003 §5). */
  readonly mms: boolean;
  /** Allow cross-codec quality switches through `changeType` (SPEC §6.2). */
  readonly allowCodecSwitch: boolean;
}

export interface EngineEvents {
  'tracks-change': TrackList;
  'quality-change': { readonly id: string; readonly auto: boolean; readonly reason: string };
  'latency-change': { readonly latency: number; readonly target?: number };
  'first-segment': { readonly at: number };
  bandwidth: { readonly estimate: number; readonly fast: number; readonly slow: number };
  /** `fatal` errors make the session fall back to the next backend. */
  error: OtterError;
}

export interface Engine {
  readonly formatId: string;
  readonly tracks: TrackList;
  readonly latency?: number | undefined;
  /** Whether the engine actually uses ManagedMediaSource; known once `load()` resolved. */
  readonly mms: boolean;
  /** Loads the engine library (dynamic import) and the manifest; resolves once tracks are known. */
  load(): Promise<void>;
  selectQuality(id: string | 'auto'): void;
  on<E extends keyof EngineEvents>(e: E, h: (p: EngineEvents[E]) => void): Unsubscribe;
  destroy(): void;
}

export interface FormatPlugin {
  readonly id: string;
  /** Confidence 0..1 that this plugin can play `source`. */
  probe(source: Source, caps: Capabilities): number;
  /** Backends this format can feed for `source`, in no particular order. */
  backends(source: Source, caps: Capabilities): readonly BackendKind[];
  createEngine(ctx: EngineContext): Engine;
}
