import { container, src } from './page.ts';
// #region example:companion
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

// Where the browser has Document Picture-in-Picture, the PiP button opens the companion window:
// dimmed, controls on hover, an audio strip on request (settings page "Floating player").
const player = createVodPlayer({ container, title: 'Example', presentation: { companion: { dim: 0.4, size: 'm' } } });
void player.load(src).catch((error: unknown) => {
  if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
});
// #endregion
export { player };
