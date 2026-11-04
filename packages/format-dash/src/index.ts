// MPEG-DASH format plugin (SPEC §8): Shaka adapter (L1). DASH has no native path in any browser.

import type { Capabilities, FormatPlugin, Source } from '@otter-player/media';
import { createShakaEngine, type ShakaEngineOptions } from '@otter-player/engine-adapter-shaka';

/** Options of the DASH format. */
export interface DashFormatOptions {
  /**
   * Shaka adapter options (extra configuration).
   * @defaultValue `{}`
   */
  readonly shaka?: ShakaEngineOptions;
  /**
   * Who decides the quality: `otter`, the pipeline ABR rule stack; `engine`, the engine's own ABR
   * (ADR-005 §1).
   * @defaultValue `'otter'`
   */
  readonly abr?: 'otter' | 'engine';
}

const DASH_TYPE = /dash\+xml/i;
const DASH_EXT = /\.mpd(\?|#|$)/i;

/** How likely a source is DASH, 0..1 (type `application/dash+xml`, `.mpd`): the router's probe. */
export function probeDash(source: Source): number {
  if (typeof source.src !== 'string') return 0;
  if (source.type !== undefined) return DASH_TYPE.test(source.type) ? 1 : 0;
  return DASH_EXT.test(source.src) ? 0.9 : 0;
}

/**
 * The MPEG-DASH format: Shaka Player, loaded on demand (DASH has no native path in any browser);
 * DRM goes here too.
 */
export function createDashFormat(options: DashFormatOptions = {}): FormatPlugin {
  return {
    id: 'dash',
    probe: probeDash,
    backends: (_source: Source, caps: Capabilities) => (caps.mediaSource || caps.managedMediaSource ? ['mse'] : []),
    createEngine: (ctx) =>
      createShakaEngine(ctx, { ...options.shaka, ...(options.abr === undefined ? {} : { abr: options.abr }), formatId: 'dash' }),
  };
}
