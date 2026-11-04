# @otter-player/demux-mediabunny

## 0.1.0-beta.0

### Minor Changes

- First beta of Otter (0.1.0-beta.0): scenario presets, the own HLS and FLV / TS engines with adapter fallbacks, WebCodecs playback, the player UI and skins, React / Vue / Svelte bindings. Release notes and known limitations: `docs/release-notes/0.1.0-beta.0.md`.
- demux-mediabunny: AAC in live MPEG-TS is read by the adapter, each PES's frames as soon as the PES has arrived (mediabunny released the last frame of each PES one PES late, a short silence at every PES on surveillance walls); audio from before the first video keyframe is kept, so live audio starts at 0.
- Live MPEG-TS audio: AAC frames cut by a PES boundary, PTS wrap-around (on mediabunny's timeline), false sync words; audio other than ADTS AAC stays on mediabunny's path with a non-fatal `tsAudioFallback` (LATM: no sound). Live FLV and TS keep audio timed at or after the first video keyframe whichever arrived first.

### Patch Changes

- Updated dependencies
  - @otter-player/core@0.1.0-beta.0
  - @otter-player/media@0.1.0-beta.0
