import { container, src } from './page.ts';
// #region example:lowlatency
import { createLowLatencyPlayer } from '@otter-player/presets/lowlatency';
import '@otter-player/ui-skin-default';

const player = createLowLatencyPlayer({ container, title: 'Live', targetLatency: 3 });
void player.load(src);
// #endregion
export { player };
