// #region example:vue
import { defineComponent, h } from 'vue';
import { OtterPlayer } from '@otter-player/vue';
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

export const Video = defineComponent({
  props: { src: { type: String, required: true } },
  setup(props) {
    const create = (container: HTMLElement) => {
      const player = createVodPlayer({ container, title: 'Example' });
      void player.load(props.src).catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
      });
      return player;
    };
    return () => h(OtterPlayer, { create, deps: [props.src] });
  },
});
// #endregion
