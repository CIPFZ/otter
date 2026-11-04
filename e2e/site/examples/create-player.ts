import { container, src } from './page.ts';
// #region example:createPlayer
import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createHlsFormat } from '@otter-player/format-hls';
import { createPlayer } from '@otter-player/presets';
import '@otter-player/ui-skin-default';

// Your own composition: only HLS, on MSE with native playback as the fallback.
const player = createPlayer({
  container,
  formats: [createHlsFormat()],
  backends: [createMseBackendFactory(), createNativeBackendFactory()],
  title: 'Example',
});
void player.load(src);
// #endregion
export { player };
