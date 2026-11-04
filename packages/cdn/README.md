# @otter-player/cdn

[Otter](https://github.com/CIPFZ/otter) for a page without a build step: `presets/basic` and
`presets/vod` as ES modules to import from a CDN, each an entry with its on-demand chunks beside it
(engines, captions and preview pictures load only when used), and their skin's stylesheet.

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@otter-player/cdn@0.1.0-beta.0/dist/otter-vod/otter-vod.css">
<div id="player"></div>
<script type="module">
  import { createVodPlayer } from 'https://cdn.jsdelivr.net/npm/@otter-player/cdn@0.1.0-beta.0/dist/otter-vod/otter-vod.esm.js';

  const player = createVodPlayer({ container: document.getElementById('player'), title: 'Example' });
  await player.load('https://example.com/master.m3u8');
</script>
```

| Entry | Exports | Skin |
|---|---|---|
| `dist/otter-basic/otter-basic.esm.js` | `@otter-player/presets/basic` (`createBasicPlayer`) | `otter-basic.css` (ui-skin-minimal) |
| `dist/otter-vod/otter-vod.esm.js` | `@otter-player/presets/vod` (`createVodPlayer`) | `otter-vod.css` (ui-skin-default) |

Pin the version in the URL: the chunk file names change between versions. With a bundler, use
`@otter-player/presets` instead.
