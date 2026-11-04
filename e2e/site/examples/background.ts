import { container, src } from './page.ts';
// #region example:background
import { createBackgroundPlayer } from '@otter-player/presets/background';

// Muted, looped, no controls; starts unless the viewer asked for reduced motion.
const player = createBackgroundPlayer({ target: container, src });
// #endregion
export { player };
