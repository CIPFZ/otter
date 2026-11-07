import { container, src } from './page.ts';
// #region example:basic
import { createBasicPlayer } from '@otter-player/presets/basic';
import '@otter-player/ui-skin-minimal';

const player = createBasicPlayer({ container });
void player.load(src).catch((error: unknown) => {
  if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
});
// #endregion
export { player };
