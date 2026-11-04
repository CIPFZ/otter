# @otter-player/presets

One-line scenario presets (SPEC §19, ADR-013). Each preset is a sub-path, so a page carries only the formats and backends of its own scenario.

```ts
import { createVodPlayer } from '@otter-player/presets/vod';
import '@otter-player/ui-skin-default';

const player = createVodPlayer({ container: document.getElementById('player')!, title: 'Example', lang: 'zh-CN' });
await player.load('https://example.com/master.m3u8');
```

| sub-path | Scenario |
|---|---|
| `/basic` | Short videos / simple VOD: five controls, mp4-range + HLS, skin `@otter-player/ui-skin-minimal` |
| `/vod` | Long-form VOD: HLS, DASH, MP4, quality, captions, preview thumbnails (captions and thumbnails are on-demand chunks, not loaded with `captions: false` / `thumbnails: false`) |
| `/live`, `/lowlatency` | Live, low-latency live |
| `/danmaku` | Danmaku sites: the `comments` option loads the comments with every `load()` |
| `/surveillance` | Surveillance walls: one GPU wall, each tile on WebCodecs (WASM for HEVC without a hardware decoder), HTTP-FLV / WS-FLV / live MPEG-TS / HLS / local files; above 6 tiles from one host use WS-FLV or HTTP/2 (browsers allow 6 HTTP/1.1 connections per host; from the 7th tile on, each gets a non-fatal `tooManyConnectionsPerHost` error); FLV / TS are treated as live, sources with `live: false` go through MSE. Known limitation: on real Windows Firefox the first frame occasionally takes about 10 s (all transports, cause not found, RESEARCH §1) |
| `/ott-drm` | OTT subscription + DRM |
| `/shorts` | Vertical feed. Gestures on the picture: swipe up for the next item, down for the previous one (more than 20 % of the height, or a short fast swipe: ≥ 0.5 px/ms over the last 100 ms and ≥ 30 px moved); tap pauses / plays; double tap calls the host's `onLike(index, at)`; 2× speed while long-pressed. All parameters are in the `gestures` option; `gestures: false` leaves only keys and the API. One `<video>` and one engine: a switch tears down the previous item before loading the next, nothing is preloaded, at most 1 live decoder at a time |
| `/tv` | TV remote control |
| `/background` | Background video (hero), no controls |

## UI language

- `lang` (BCP 47, e.g. `zh-CN`, `en`) is set on the player root and takes precedence over the page's `lang`.
- When not given: the nearest `lang` on the page, then `navigator.language`, then English.
- English and Chinese are built in. Other languages through `provideStrings`:

```ts
import { provideStrings, STRINGS_EN, type UiStrings } from '@otter-player/ui-core';

const ja: UiStrings = { ...STRINGS_EN, locale: 'ja', play: '再生', pause: '一時停止' /* … */ };
provideStrings(player.element, ja);
```

## Danmaku (`/danmaku`)

```ts
const player = createDanmakuPlayer({ container, comments: (src) => src.replace(/\.mpd$/, '.xml') });
await player.load('/video.mpd'); // its comments load with it
await player.load('/other.mpd', { comments: null }); // no comments this time
```

`comments` is a URL, or a function from the video URL to the comments URL (returning `undefined` means this video has no comments). On a switch, a video without comments clears the previous one's; without `comments` the preset leaves danmaku alone and the host uses `dispatch('load-danmaku', …)`.

## Frame-accurate work (editing / annotation) and Safari

On Safari (WebKit), a seek on a paused `<video>` may stop on an earlier frame without repainting: a platform limitation (RESEARCH §1, ADR-008 §6.1). For frame accuracy use the WebCodecs path: hand local files or Blobs to `@otter-player/format-file` with the backend `@otter-player/backend-webcodecs`, and the player draws the frames on a canvas (the §19 editing row's combination). This path is frame-accurate on Safari (the webcodecs case of e2e `picture.spec`).
