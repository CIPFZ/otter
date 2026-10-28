// The scenario presets as a host uses them (ADR-013): one call with a container and a source.
// ?preset=basic|vod|live|lowlatency|danmaku|tv|background&src=<url>[&wm=1][&thumbs=0&captions=0].
// window.preset exposes the handle to the tests.

import { createBackgroundPlayer, type BackgroundPlayer } from '@otter-player/presets/background';
import { createBasicPlayer, type BasicPlayer } from '@otter-player/presets/basic';
import { createDanmakuPlayer } from '@otter-player/presets/danmaku';
import { createLivePlayer } from '@otter-player/presets/live';
import { createLowLatencyPlayer } from '@otter-player/presets/lowlatency';
import { createTvPlayer } from '@otter-player/presets/tv';
import { createVodPlayer } from '@otter-player/presets/vod';
import type { Player } from '@otter-player/presets';
import { findThumbnails } from '@otter-player/ui-core';

declare global {
  interface Window {
    preset?: Player | BackgroundPlayer | BasicPlayer;
    /** Whether a preview-picture provider is installed on the player (vod loads it on demand). */
    hasThumbnails?: () => boolean;
  }
}

const params = new URLSearchParams(location.search);
const src = params.get('src') ?? '';
const kind = params.get('preset');
const container = document.getElementById('player') as HTMLElement;
window.hasThumbnails = () => findThumbnails(container) !== undefined;
// Muted: browsers allow autoplay only without sound.
const common = { container, title: `Preset ${kind}`, idleMs: 0, muted: true } as const;
let player: Player | undefined;
if (kind === 'background') {
  window.preset = createBackgroundPlayer({ target: document.getElementById('hero') as HTMLElement, src });
} else if (kind === 'basic') {
  const basic = createBasicPlayer({ container, idleMs: 0, muted: true });
  window.preset = basic;
  void basic.load(src, { autoplay: true });
} else if (kind === 'vod') {
  player = createVodPlayer({ ...common, thumbnails: params.get('thumbs') !== '0', captions: params.get('captions') !== '0' });
} else if (kind === 'live') {
  player = createLivePlayer(common);
} else if (kind === 'lowlatency') {
  player = createLowLatencyPlayer(common);
} else if (kind === 'tv') {
  // A TV keeps its own idle delay (5 s); 0 here would keep the controls up for the focus checks anyway.
  player = createTvPlayer({ container, title: 'Preset tv', muted: true });
} else if (kind === 'danmaku') {
  player = createDanmakuPlayer({
    ...common,
    preferences: params.get('prefs') !== '0',
    ...(params.get('wm') === '1' ? { watermark: { mode: 'static' as const, text: 'OTTER-WM', color: '#00ff00', opacity: 1, fontSize: 40 } } : {}),
  }) as unknown as Player;
}
if (player !== undefined) {
  window.preset = player;
  void player.load(src, { autoplay: true });
}
