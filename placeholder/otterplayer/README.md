# otterplayer

This name is held for [Otter](https://github.com/CIPFZ/otter), a pluggable web video player. The
packages are published under the `@otter-player` scope; start with the presets:

```bash
npm install @otter-player/presets@beta @otter-player/ui-skin-default@beta
```

```ts
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

const player = createVodPlayer({ container: document.getElementById('player')!, title: 'Example' });
await player.load('https://example.com/master.m3u8');
```
