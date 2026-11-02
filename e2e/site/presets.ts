// The scenario presets as a host uses them (ADR-013): one call with a container and a source.
// ?preset=basic|vod|ott-drm|shorts|surveillance|live|lowlatency|danmaku|tv|background&src=<url>[&wm=1][&thumbs=0&captions=0].
// window.preset exposes the handle to the tests.

import { createBackgroundPlayer, type BackgroundPlayer } from '@otter-player/presets/background';
import { createBasicPlayer, type BasicPlayer } from '@otter-player/presets/basic';
import { createOttDrmPlayer } from '@otter-player/presets/ott-drm';
import { createShortsPlayer, type ShortsPlayer } from '@otter-player/presets/shorts';
import { createSurveillancePlayer, type SurveillancePlayer } from '@otter-player/presets/surveillance';
import type { DrmConfig } from '@otter-player/media';
import { createDanmakuPlayer } from '@otter-player/presets/danmaku';
import { createLivePlayer } from '@otter-player/presets/live';
import { createLowLatencyPlayer } from '@otter-player/presets/lowlatency';
import { createTvPlayer } from '@otter-player/presets/tv';
import { createVodPlayer } from '@otter-player/presets/vod';
import type { Player } from '@otter-player/presets';
import { findThumbnails } from '@otter-player/ui-core';

declare global {
  interface Window {
    preset?: Player | BackgroundPlayer | BasicPlayer | ShortsPlayer | SurveillancePlayer;
    /** ott-drm: the DRM config a test sets before the page script runs (init script). */
    OTTER_DRM?: DrmConfig;
    /** Whether a preview-picture provider is installed on the player (vod loads it on demand). */
    hasThumbnails?: () => boolean;
  }
}

const params = new URLSearchParams(location.search);
const src = params.get('src') ?? '';
const kind = params.get('preset');
const container = document.getElementById('player') as HTMLElement;
window.hasThumbnails = () => findThumbnails(container) !== undefined;
// Muted: browsers allow autoplay only without sound.
// ?lang=zh-CN: the presets' `lang` option; without it the page has no lang, so the browser's language decides.
const lang = params.get('lang');
const common = { container, title: `Preset ${kind}`, idleMs: 0, muted: true, ...(lang === null ? {} : { lang }) } as const;
let player: Player | undefined;
if (kind === 'background') {
  window.preset = createBackgroundPlayer({ target: document.getElementById('hero') as HTMLElement, src });
} else if (kind === 'basic') {
  const basic = createBasicPlayer({ container, idleMs: 0, muted: true, ...(lang === null ? {} : { lang }) });
  window.preset = basic;
  void basic.load(src, { autoplay: true });
} else if (kind === 'ott-drm') {
  player = createOttDrmPlayer({ ...common, ...(window.OTTER_DRM === undefined ? {} : { drm: window.OTTER_DRM }) });
} else if (kind === 'shorts') {
  // ?feed=<url>,<url>: the preset loads the first itself.
  window.preset = createShortsPlayer({ container, idleMs: 0, feed: (params.get('feed') ?? src).split(','), ...(lang === null ? {} : { lang }) });
} else if (kind === 'surveillance') {
  // ?streams=<url>,<url>,...: one tile each.
  window.preset = createSurveillancePlayer({ container, title: 'Preset surveillance', idleMs: 0, streams: (params.get('streams') ?? src).split(','), ...(lang === null ? {} : { lang }) });
} else if (kind === 'vod') {
  player = createVodPlayer({ ...common, thumbnails: params.get('thumbs') !== '0', captions: params.get('captions') !== '0' });
} else if (kind === 'live') {
  player = createLivePlayer(common);
} else if (kind === 'lowlatency') {
  player = createLowLatencyPlayer(common);
} else if (kind === 'tv') {
  // A TV keeps its own idle delay (5 s); 0 here would keep the controls up for the focus checks anyway.
  player = createTvPlayer({ container, title: 'Preset tv', muted: true, ...(lang === null ? {} : { lang }) });
} else if (kind === 'danmaku') {
  // One call: the comments come with each load (?comments=<url>, default the fixture's ladder.xml).
  player = createDanmakuPlayer({
    ...common,
    comments: params.get('comments') ?? '/danmaku/ladder.xml',
    preferences: params.get('prefs') !== '0',
    ...(params.get('wm') === '1' ? { watermark: { mode: 'static' as const, text: 'OTTER-WM', color: '#00ff00', opacity: 1, fontSize: 40 } } : {}),
  }) as unknown as Player;
}
if (player !== undefined) {
  window.preset = player;
  void player.load(src, { autoplay: true });
}
