// The fixture each docs example runs with on the e2e site (examples.html?example=<name>&src=...):
// the docs site's "run it" links and e2e/examples.spec.ts use the same.
export const EXAMPLE_SOURCES: Readonly<Record<string, string>> = {
  createPlayer: '/hls-fmp4/master.m3u8',
  basic: '/hls-fmp4/master.m3u8',
  vod: '/hls-fmp4/master.m3u8',
  live: '/live-hls/master.m3u8',
  lowlatency: '/hls-unsupported/ll-parts/master.m3u8',
  'ott-drm': '/dash-clearkey/manifest.mpd',
  surveillance: '/live/stream.flv,/live/stream.ts',
  danmaku: '/dash-av/manifest.mpd',
  shorts: '/frames/h264.mp4,/hls-fmp4/master.m3u8',
  tv: '/frames/hls-ladder/master.m3u8',
  background: '/frames/h264-video-only.mp4',
  react: '/hls-fmp4/master.m3u8',
  vue: '/hls-fmp4/master.m3u8',
  svelte: '/hls-fmp4/master.m3u8',
};
