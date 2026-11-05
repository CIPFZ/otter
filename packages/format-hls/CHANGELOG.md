# @otter-player/format-hls

## 0.1.0-beta.0

### Minor Changes

- First beta of Otter (0.1.0-beta.0): scenario presets, the own HLS and FLV / TS engines with adapter fallbacks, WebCodecs playback, the player UI and skins, React / Vue / Svelte bindings. Release notes and known limitations: `docs/release-notes/0.1.0-beta.0.md`.
- format-hls prefetches hls.js once the own engine plays (idle, not with Save-Data), so a hand-over does not wait for its download; a live playlist that gains something the own engine leaves to hls.js (EXT-X-DISCONTINUITY …) now hands over at once instead of retrying reloads. New `prefetchHlsJs()` in engine-adapter-hlsjs.
- format-hls: the hls.js and Shaka adapters load with their first use (a stream the own engine hands over, a DRM source), not with the page: the short-VOD first load is 25.5 KB gzip (was 30.3).
- engine-pipeline/sink: `SinkSegment.rendition` names the rendition a segment came from (was `level`).

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @otter-player/core@0.1.0-beta.0
  - @otter-player/demux-mediabunny@0.1.0-beta.0
  - @otter-player/engine-adapter-hlsjs@0.1.0-beta.0
  - @otter-player/engine-adapter-shaka@0.1.0-beta.0
  - @otter-player/engine-pipeline@0.1.0-beta.0
  - @otter-player/media@0.1.0-beta.0
  - @otter-player/pipeline@0.1.0-beta.0
