import { container, src } from './page.ts';
// #region example:tv
import { createTvPlayer } from '@otter-player/presets/tv';
import '@otter-player/ui-skin-tv';

const player = createTvPlayer({ container, title: 'Example', remote: { keys: { back: ['Escape', 'GoBack', 10009, 461] } } });
void player.load(src).catch((error: unknown) => {
  if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
});
// #endregion
export { player };
