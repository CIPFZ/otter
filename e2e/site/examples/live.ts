import { container, src } from './page.ts';
// #region example:live
import { createLivePlayer } from '@otter-player/presets/live';
import '@otter-player/ui-skin-default';

const player = createLivePlayer({ container, title: 'Live' });
void player.load(src);
// #endregion
export { player };
