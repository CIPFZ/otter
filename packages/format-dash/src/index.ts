// MPEG-DASH format plugin (SPEC §8): Shaka adapter (L1). DASH has no native path in any browser.

import type { Capabilities, FormatPlugin, Source } from '@otter-player/media';
import { createShakaEngine, type ShakaEngineOptions } from '@otter-player/engine-adapter-shaka';

export interface DashFormatOptions {
  readonly shaka?: ShakaEngineOptions;
}

const DASH_TYPE = /dash\+xml/i;
const DASH_EXT = /\.mpd(\?|#|$)/i;

export function probeDash(source: Source): number {
  if (typeof source.src !== 'string') return 0;
  if (source.type !== undefined) return DASH_TYPE.test(source.type) ? 1 : 0;
  return DASH_EXT.test(source.src) ? 0.9 : 0;
}

export function createDashFormat(options: DashFormatOptions = {}): FormatPlugin {
  return {
    id: 'dash',
    probe: probeDash,
    backends: (_source: Source, caps: Capabilities) => (caps.mediaSource || caps.managedMediaSource ? ['mse'] : []),
    createEngine: (ctx) => createShakaEngine(ctx, { ...options.shaka, formatId: 'dash' }),
  };
}
