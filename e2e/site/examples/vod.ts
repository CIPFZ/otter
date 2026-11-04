import { container, src } from './page.ts';
// #region example:vod
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

const player = createVodPlayer({ container, title: 'Example' });
void player.load(src);
// #endregion
export { player };
