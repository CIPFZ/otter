import { container, src } from './page.ts';
// #region example:companion
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

// Where the browser has Document Picture-in-Picture, the PiP button opens the companion window:
// dimmed, controls on hover, a dimming slider and an audio strip switch in the window.
const player = createVodPlayer({ container, title: 'Example', presentation: { companion: { dim: 0.4 } } });
void player.load(src).catch((error: unknown) => {
  if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
});
// #endregion
export { player };
