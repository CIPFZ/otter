# @otter-player/ui-core

## 0.1.0-beta.0

### Minor Changes

- First beta of Otter (0.1.0-beta.0): scenario presets, the own HLS and FLV / TS engines with adapter fallbacks, WebCodecs playback, the player UI and skins, React / Vue / Svelte bindings. Release notes and known limitations: `docs/release-notes/0.1.0-beta.0.md`.
- ui-core: the player UI API is `PlayerUiState`, `PlayerUiActionMap`, `PlayerUiOptions`, `PlayerUiInputActions`, `PLAYER_UI_SLICE`, `INITIAL_PLAYER_UI_STATE` and `createPlayerUiPlugin` (were `Chrome*`, `CHROME_SLICE`, `INITIAL_CHROME_STATE`, `createChromePlugin`); the slice and plugin id is `player-ui`.

### Patch Changes

- Updated dependencies
  - @otter-player/core@0.1.0-beta.0
  - @otter-player/input@0.1.0-beta.0
  - @otter-player/media@0.1.0-beta.0
  - @otter-player/presentation@0.1.0-beta.0
  - @otter-player/qoe@0.1.0-beta.0
  - @otter-player/surface@0.1.0-beta.0
  - @otter-player/text@0.1.0-beta.0
