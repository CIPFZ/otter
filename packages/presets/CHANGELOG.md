# @otter-player/presets

## 0.1.0-beta.0

### Minor Changes

- First beta of Otter (0.1.0-beta.0): scenario presets, the own HLS and FLV / TS engines with adapter fallbacks, WebCodecs playback, the player UI and skins, React / Vue / Svelte bindings. Release notes and known limitations: `docs/release-notes/0.1.0-beta.0.md`.
- Live sources with sound on WebCodecs start once the decoded audio is 300 ms ahead of the clock (a minimal, fixed jitter buffer): the first frame still shows at once, the clock starts at the latest 1 s after it, and audio running dry while playing is reported, not waited for. New option `liveAudioLeadMs` on `createWebCodecsBackendFactory` and on the surveillance preset (`0`: start at once). Before, a stream joined in the middle of a GOP (audio muxed ~0.3 s behind the video, as ffmpeg writes it) ran dry at every audio PES. Live MPEG-TS AAC frames now come out as soon as each frame is in, not when its PES is complete.
- ui-core: the player UI API is `PlayerUiState`, `PlayerUiActionMap`, `PlayerUiOptions`, `PlayerUiInputActions`, `PLAYER_UI_SLICE`, `INITIAL_PLAYER_UI_STATE` and `createPlayerUiPlugin` (were `Chrome*`, `CHROME_SLICE`, `INITIAL_CHROME_STATE`, `createChromePlugin`); the slice and plugin id is `player-ui`.
- presets: the option that turns the default player UI on or off is `ui` (was `controls`).
- surveillance: WebCodecs decoders only by default; a host adds others (a WASM HEVC decoder) with the `decoders` option, and an HEVC stream without a decoder reports the non-fatal `hevcDecoderUnavailable`.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @otter-player/backend-mse@0.1.0-beta.0
  - @otter-player/backend-native@0.1.0-beta.0
  - @otter-player/backend-webcodecs@0.1.0-beta.0
  - @otter-player/core@0.1.0-beta.0
  - @otter-player/danmaku@0.1.0-beta.0
  - @otter-player/decoder-webcodecs@0.1.0-beta.0
  - @otter-player/format-dash@0.1.0-beta.0
  - @otter-player/format-file@0.1.0-beta.0
  - @otter-player/format-flv@0.1.0-beta.0
  - @otter-player/format-hls@0.1.0-beta.0
  - @otter-player/format-mp4-range@0.1.0-beta.0
  - @otter-player/format-ts@0.1.0-beta.0
  - @otter-player/input@0.1.0-beta.0
  - @otter-player/media@0.1.0-beta.0
  - @otter-player/overlay-thumbnails@0.1.0-beta.0
  - @otter-player/overlay-watermark@0.1.0-beta.0
  - @otter-player/preferences@0.1.0-beta.0
  - @otter-player/presentation@0.1.0-beta.0
  - @otter-player/qoe@0.1.0-beta.0
  - @otter-player/surface@0.1.0-beta.0
  - @otter-player/text@0.1.0-beta.0
  - @otter-player/ui-core@0.1.0-beta.0
