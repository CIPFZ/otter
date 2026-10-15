// FormatPlugin (SPEC §5): scores a source and produces the pipeline assembly that drives a backend.

import type { QoeHook } from '@otter-player/core';
import type { BackendKind } from './backend.js';
import type { Capabilities } from './capabilities.js';
import type { LoadOptions, Source } from './source.js';

export interface EngineContext {
  readonly source: Source;
  readonly options: LoadOptions;
  readonly caps: Capabilities;
  readonly backend: BackendKind;
  readonly qoe: QoeHook;
}

/**
 * Pipeline assembly produced by a FormatPlugin (SPEC §5, §7): either an engine adapter
 * (hls.js / Shaka / mpegts.js) or the self-built pipeline. Provisional in M0; the attach
 * contract with backend-mse is settled in M1 against the real adapters.
 */
export interface Engine {
  readonly formatId: string;
  load(): Promise<void>;
  destroy(): void;
}

export interface FormatPlugin {
  readonly id: string;
  /** Confidence 0..1 that this plugin can play `source`. */
  probe(source: Source, caps: Capabilities): number;
  createEngine(ctx: EngineContext): Engine;
}
