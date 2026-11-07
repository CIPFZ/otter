import { container, src } from './page.ts';
// #region example:danmaku
import { createDanmakuPlayer } from '@otter-player/presets/danmaku';
import '@otter-player/ui-skin-default';

// comments: a URL, or a function from each video's URL to its comments' URL.
const player = createDanmakuPlayer({ container, title: 'Example', comments: '/danmaku/ladder.xml' });
void player.load(src).catch((error: unknown) => {
  if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
});
// #endregion
export { player };
