// #region example:react
import { OtterPlayer } from '@otter-player/react';
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

export function Video({ src }: { src: string }) {
  return (
    <OtterPlayer
      create={(container) => {
        const player = createVodPlayer({ container, title: 'Example' });
        void player.load(src).catch((error: unknown) => {
          if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
        });
        return player;
      }}
      deps={[src]}
    />
  );
}
// #endregion
