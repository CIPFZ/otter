import { container, src } from './page.ts';
// #region example:vod
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

const player = createVodPlayer({ container, title: 'Example' });
void player.load(src).catch((error: unknown) => {
  if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
});
// #endregion
export { player };
