// The scenario presets as a host uses them (ADR-013): one call with a container and a source.
// ?preset=vod|live|background&src=<url>. window.preset exposes the handle to the tests.

import { createBackgroundPlayer, type BackgroundPlayer } from '@otter-player/presets/background';
import { createLivePlayer } from '@otter-player/presets/live';
import { createVodPlayer } from '@otter-player/presets/vod';
import type { Player } from '@otter-player/presets';

declare global {
  interface Window {
    preset?: Player | BackgroundPlayer;
  }
}

const params = new URLSearchParams(location.search);
const src = params.get('src') ?? '';
const kind = params.get('preset');
if (kind === 'background') {
  window.preset = createBackgroundPlayer({ target: document.getElementById('hero') as HTMLElement, src });
} else if (kind === 'vod' || kind === 'live') {
  const container = document.getElementById('player') as HTMLElement;
  const player = (kind === 'vod' ? createVodPlayer : createLivePlayer)({ container, title: `Preset ${kind}`, idleMs: 0 });
  window.preset = player;
  void player.load(src, { autoplay: true });
}
