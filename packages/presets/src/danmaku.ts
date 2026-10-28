// Preset `danmaku` (SPEC §19「B 站式弹幕站」): DASH with separate audio and video (Shaka), HLS (own
// engine) and MP4 range, codec probing (the session's), the viewer's choices kept across visits
// (preferences: volume, speed, quality, captions, danmaku settings, codec failures), the danmaku
// engine (Canvas 2D, WebGL / Worker chosen by load, masks; its settings page in the menu) and an
// optional watermark that follows fullscreen, Document PiP and video PiP.
// Comments: `player.store.dispatch('load-danmaku', { url })` after each load.
// The default skin is the host's stylesheet: `import '@otter-player/ui-skin-default'`.

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDanmaku, DANMAKU_SLICE, type DanmakuActionMap, type DanmakuState } from '@otter-player/danmaku';
import { createDashFormat } from '@otter-player/format-dash';
import { createHlsFormat } from '@otter-player/format-hls';
import { createMp4RangeFormat } from '@otter-player/format-mp4-range';
import { createPipComposite, createWatermark, type WatermarkOptions } from '@otter-player/overlay-watermark';
import { createPreferencesPlugin } from '@otter-player/preferences';
import { bindCanvasPip, canvasPipSupported, type CanvasPip } from '@otter-player/presentation/canvas-pip';
import type { PresetOptions } from './options.js';
import { createPlayer, type Player, type PlayerActions, type PlayerState } from './player.js';

export type DanmakuPlayerState = PlayerState & DanmakuState;
export type DanmakuPlayerActions = PlayerActions & DanmakuActionMap;

export interface DanmakuPresetOptions extends PresetOptions<DanmakuPlayerState, DanmakuPlayerActions> {
  /** Danmaku renderer: `auto` (default: Canvas 2D, WebGL / Worker under load) or a fixed one. */
  readonly renderer?: 'auto' | 'canvas2d' | 'webgl' | 'worker';
  /** A watermark over the picture (static corner mark or moving viewer id). */
  readonly watermark?: WatermarkOptions;
  /** Keep the viewer's choices across visits (localStorage). Default true. */
  readonly preferences?: boolean;
}

export function createDanmakuPlayer(options: DanmakuPresetOptions): Player<DanmakuPlayerState, DanmakuPlayerActions> {
  const danmaku = createDanmaku(options.renderer === undefined ? {} : { renderer: options.renderer });
  const watermark = options.watermark === undefined ? undefined : createWatermark(options.watermark);
  let canvasPip: CanvasPip | undefined;
  const pip = watermark !== undefined && canvasPipSupported(document);
  return createPlayer<DanmakuPlayerState, DanmakuPlayerActions>({
    ...options,
    formats: [createDashFormat(), createHlsFormat(), createMp4RangeFormat()],
    backends: [createMseBackendFactory(), createNativeBackendFactory()],
    // Video PiP shows only a <video>: with a watermark, a stream of picture + mark goes there.
    ...(pip ? { presentation: { ...options.presentation, pipVideo: () => canvasPip?.pipVideo() } } : {}),
    slices: [DANMAKU_SLICE, ...(options.slices ?? [])],
    plugins: [danmaku.plugin, ...(options.preferences === false ? [] : [createPreferencesPlugin<DanmakuPlayerState, DanmakuPlayerActions>()]), ...(options.plugins ?? [])],
    explain: { danmaku: (s) => s.danmakuStatus.steps, ...options.explain },
    setup(parts) {
      parts.layer.add(danmaku.overlay);
      const offs: (() => void)[] = [];
      if (watermark !== undefined) {
        parts.layer.add(watermark.overlay);
        if (pip) {
          const composite = createPipComposite(parts.root.ownerDocument, () => parts.video, watermark);
          canvasPip = bindCanvasPip(parts.root.ownerDocument, parts.store, () => composite.canvas);
          offs.push(() => composite.destroy(), () => canvasPip?.destroy());
        }
      }
      const more = options.setup?.(parts);
      return () => {
        for (const off of offs) off();
        more?.();
      };
    },
  });
}
