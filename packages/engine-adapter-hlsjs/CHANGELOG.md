# @otter-player/engine-adapter-hlsjs

## 0.1.0-beta.0

### Minor Changes

- First beta of Otter (0.1.0-beta.0): scenario presets, the own HLS and FLV / TS engines with adapter fallbacks, WebCodecs playback, the player UI and skins, React / Vue / Svelte bindings. Release notes and known limitations: `docs/release-notes/0.1.0-beta.0.md`.
- format-hls prefetches hls.js once the own engine plays (idle, not with Save-Data), so a hand-over does not wait for its download; a live playlist that gains something the own engine leaves to hls.js (EXT-X-DISCONTINUITY …) now hands over at once instead of retrying reloads. New `prefetchHlsJs()` in engine-adapter-hlsjs.

### Patch Changes

- Updated dependencies
  - @otter-player/core@0.1.0-beta.0
  - @otter-player/media@0.1.0-beta.0
  - @otter-player/pipeline@0.1.0-beta.0
