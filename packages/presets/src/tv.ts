// Preset `tv` (SPEC §19「电视遥控器」): HLS (own engine) and DASH on MSE, driven by a remote
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

export interface TvOptions extends PresetOptions {
  /** Remote keys (names or platform key codes per logical key) and the hold-to-seek steps. */
  readonly remote?: RemoteOptions;
}

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
