# @otter-player/backend-webcodecs

## 0.1.0-beta.0

### Minor Changes

- First beta of Otter (0.1.0-beta.0): scenario presets, the own HLS and FLV / TS engines with adapter fallbacks, WebCodecs playback, the player UI and skins, React / Vue / Svelte bindings. Release notes and known limitations: `docs/release-notes/0.1.0-beta.0.md`.
- Live sources with sound on WebCodecs start once the decoded audio is 300 ms ahead of the clock (a minimal, fixed jitter buffer): the first frame still shows at once, the clock starts at the latest 1 s after it, and audio running dry while playing is reported, not waited for. New option `liveAudioLeadMs` on `createWebCodecsBackendFactory` and on the surveillance preset (`0`: start at once). Before, a stream joined in the middle of a GOP (audio muxed ~0.3 s behind the video, as ffmpeg writes it) ran dry at every audio PES. Live MPEG-TS AAC frames now come out as soon as each frame is in, not when its PES is complete.
- surveillance: WebCodecs decoders only by default; a host adds others (a WASM HEVC decoder) with the `decoders` option, and an HEVC stream without a decoder reports the non-fatal `hevcDecoderUnavailable`.

### Patch Changes

- Updated dependencies
  - @otter-player/core@0.1.0-beta.0
  - @otter-player/media@0.1.0-beta.0
  - @otter-player/pipeline@0.1.0-beta.0
