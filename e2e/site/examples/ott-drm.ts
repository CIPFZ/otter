import { container, drm, src } from './page.ts';
// #region example:ott-drm
import { createOttDrmPlayer } from '@otter-player/presets/ott-drm';
import '@otter-player/ui-skin-default';

// drm: { servers: { 'com.widevine.alpha': 'https://license.example.com/widevine' } }
const player = createOttDrmPlayer({ container, title: 'Example', drm });
void player.load(src).catch((error: unknown) => {
  if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
});
// #endregion
export { player };
