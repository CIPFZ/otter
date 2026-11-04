# @otter-player/backend-webcodecs

## 0.1.0-beta.0

### Minor Changes

- First beta of Otter (0.1.0-beta.0): scenario presets, the own HLS and FLV / TS engines with adapter fallbacks, WebCodecs playback, the player UI and skins, React / Vue / Svelte bindings. Release notes and known limitations: `docs/release-notes/0.1.0-beta.0.md`.
- surveillance: WebCodecs decoders only by default; a host adds others (a WASM HEVC decoder) with the `decoders` option, and an HEVC stream without a decoder reports the non-fatal `hevcDecoderUnavailable`.

### Patch Changes

- Updated dependencies
  - @otter-player/core@0.1.0-beta.0
  - @otter-player/media@0.1.0-beta.0
  - @otter-player/pipeline@0.1.0-beta.0
