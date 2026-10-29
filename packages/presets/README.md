# @otter-player/presets

一行接入的场景 preset（SPEC §19，ADR-013）。每个 preset 是一个 sub-path，页面只带自己场景的格式与后端。

```ts
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

const player = createVodPlayer({ container: document.getElementById('player')!, title: '示例', lang: 'zh-CN' });
await player.load('https://example.com/master.m3u8');
```

| sub-path | 场景 |
|---|---|
| `/basic` | 短视频 / 简单点播：五个控件，mp4-range + HLS，皮肤用 `@otter-player/ui-skin-minimal` |
| `/vod` | 长视频点播：HLS、DASH、MP4，清晰度、字幕、预览图（字幕与预览图是按需块，`captions: false` / `thumbnails: false` 时不加载） |
| `/live`、`/lowlatency` | 直播、低延迟直播 |
| `/danmaku` | 弹幕站：`comments` 选项随每次 `load()` 加载弹幕 |
| `/tv` | 电视遥控器 |
| `/background` | 背景视频（Hero），没有控件 |

## 界面语言

- `lang`（BCP 47，如 `zh-CN`、`en`）设在播放器根上，优先于页面的 `lang`。
- 不给时：页面上最近的 `lang`，再看 `navigator.language`，最后英文。
- 自带英文与中文。其他语言用 `provideStrings`：

```ts
import { provideStrings, STRINGS_EN, type UiStrings } from '@otter-player/ui-core';

const ja: UiStrings = { ...STRINGS_EN, locale: 'ja', play: '再生', pause: '一時停止' /* … */ };
provideStrings(player.element, ja);
```

## 弹幕（`/danmaku`）

```ts
const player = createDanmakuPlayer({ container, comments: (src) => src.replace(/\.mpd$/, '.xml') });
await player.load('/video.mpd'); // 弹幕随之加载
await player.load('/other.mpd', { comments: null }); // 这一次不要弹幕
```

`comments` 可以是一个 URL，或者由视频地址求出弹幕地址的函数（返回 `undefined` 表示这个视频没有弹幕）。换视频时，没有弹幕的视频会清掉上一个的弹幕；不给 `comments` 时 preset 不碰弹幕，由宿主 `dispatch('load-danmaku', …)`。
