// Preset `tv` (SPEC §19 row "TV remote"): HLS (own engine) and DASH on MSE, driven by a remote
// (@otter-player/input/remote): arrow keys move the focus between the controls (spatial
// navigation), OK activates, Back closes a menu or leaves the controls, media keys play / pause /
// seek. On the picture (nothing focused), Left / Right seek, faster while held, and Up / Down
// bring the controls up. The key map (names and platform key codes) is the `remote` option's.
// Skin: `import '@otter-player/ui-skin-tv'` (10-foot type, safe area, large focus rings).

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDashFormat } from '@otter-player/format-dash';
import { createHlsFormat } from '@otter-player/format-hls';
import { DEFAULT_HOTKEYS, type HotkeyMap } from '@otter-player/input';
import { bindRemote, type RemoteOptions } from '@otter-player/input/remote';
import type { PresetOptions } from './options.js';
import { createPlayer, type Player } from './player.js';

/**
 * Keyboard keys on top of SPEC §14.3 for a TV's keyboard (Up / Down are focus moves here, not
 * volume: the TV has its own). The remote's keys, platform codes included, are the remote's.
 */
export const TV_HOTKEYS: HotkeyMap = (() => {
  const { ArrowUp: _up, ArrowDown: _down, ...rest } = DEFAULT_HOTKEYS;
  return {
    ...rest,
    MediaPlayPause: { type: 'toggle-paused' },
    MediaPlay: { type: 'toggle-paused' },
    MediaPause: { type: 'toggle-paused' },
    MediaFastForward: { type: 'seek-by', seconds: 10 },
    MediaRewind: { type: 'seek-by', seconds: -10 },
  };
})();

/** Options of the `tv` preset: {@link PresetOptions} and the remote. */
export interface TvOptions extends PresetOptions {
  /**
   * Remote keys (names or platform key codes per logical key) and the hold-to-seek steps.
   * @defaultValue `{}` (`DEFAULT_REMOTE_KEYS`, steps of 10 s / 30 s / 60 s)
   */
  readonly remote?: RemoteOptions;
  /**
   * Control bar auto-hide delay, ms; 0 keeps the controls shown.
   * @defaultValue `5000`
   */
  readonly idleMs?: number;
  /**
   * Keyboard mapping (a TV keyboard's; the remote's keys are `remote`'s).
   * @defaultValue `TV_HOTKEYS`
   */
  readonly hotkeys?: HotkeyMap;
}

/**
 * A TV player driven by a remote: HLS (own engine) and DASH on MSE; arrow keys move the focus
 * between the controls, OK activates, Back closes a menu or leaves the controls, media keys play /
 * pause / seek. Skin: `@otter-player/ui-skin-tv`.
 * @example
 * ```ts
 * import { createTvPlayer } from '@otter-player/presets/tv';
 * import '@otter-player/ui-skin-tv';
 *
 * const player = createTvPlayer({ container, title: 'Example', remote: { keys: { back: ['Escape', 'GoBack', 10009, 461] } } });
 * void player.load(src);
 * ```
 */
export function createTvPlayer(options: TvOptions): Player {
  return createPlayer({
    idleMs: 5000,
    hotkeys: TV_HOTKEYS,
    ...options,
    formats: [createHlsFormat(), createDashFormat()],
    backends: [createMseBackendFactory(), createNativeBackendFactory()],
    setup(parts) {
      const off = bindRemote(parts.root, parts.store as unknown as Parameters<typeof bindRemote>[1], options.remote);
      const more = options.setup?.(parts);
      return () => {
        off();
        more?.();
      };
    },
  });
}
