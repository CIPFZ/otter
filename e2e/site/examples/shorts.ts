import { container, sources } from './page.ts';
// #region example:shorts
import { createShortsPlayer } from '@otter-player/presets/shorts';
import '@otter-player/ui-skin-minimal';

// Loads feed[0] itself; swipe up / down for the next / previous one.
const player = createShortsPlayer({ container, feed: sources, onLike: (index) => console.log('liked', index) });
// #endregion
export { player };
