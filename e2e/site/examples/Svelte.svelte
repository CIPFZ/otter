<!-- #region example:svelte -->
<script>
  import { otterPlayer } from '@otter-player/svelte';
  import { createVodPlayer } from '@otter-player/presets/vod';
  import '@otter-player/ui-skin-default';

  let { src } = $props();
  const create = (container) => {
    const player = createVodPlayer({ container, title: 'Example' });
    void player.load(src);
    return player;
  };
</script>

<div style="aspect-ratio: 16 / 9" use:otterPlayer={{ create, deps: [src] }}></div>
<!-- #endregion -->
