import { container, src } from './page.ts';
// #region example:live
import { createLivePlayer } from '@otter-player/presets/live';
import '@otter-player/ui-skin-default';

const player = createLivePlayer({ container, title: 'Live' });
void player.load(src).catch((error: unknown) => {
  if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
});
// #endregion
export { player };
