// Companion mode (ADR-016) on a createPlayer preset (vod) with the viewer's preferences:
// toggle-pip opens the companion window where Document PiP exists.
// ?src=<url> (default the local progressive MP4), ?dim=, ?size=, ?remember=0, ?lang=.

import type { CompanionOptions } from '@otter-player/presentation';
import { createPreferencesPlugin } from '@otter-player/preferences';
import type { Player } from '@otter-player/presets';
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

declare global {
  interface Window {
    player?: Player;
  }
}

const params = new URLSearchParams(location.search);
const container = document.getElementById('player') as HTMLElement;
const size = params.get('size');
const companion: CompanionOptions = {
  ...(params.has('dim') ? { dim: Number(params.get('dim')) } : {}),
  ...(size === 's' || size === 'm' || size === 'l' ? { size } : {}),
  ...(params.get('remember') === '0' ? { remember: false } : {}),
};
const lang = params.get('lang');
const player = createVodPlayer({
  container,
  title: 'Companion',
  muted: true,
  ...(lang === null ? {} : { lang }),
  presentation: { companion },
  plugins: [createPreferencesPlugin()],
});
window.player = player;
void player.load(params.get('src') ?? '/vod/progressive.mp4').catch((error: unknown) => {
  if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
});
