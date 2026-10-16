# Third-Party Notices

Otter is licensed under Apache-2.0 (see `LICENSE`). This file lists third-party code that is
vendored (REUSE L2) or copied at file level (REUSE L3) into this repository, and the third-party
runtime dependencies (REUSE L1) of the published packages. Each vendored entry must match a
`UPSTREAM.json` and the `// Derived from <project>@<commit> <path>, <license>` header of every
derived file; `scripts/check-vendor.ts` enforces this in CI.

All projects below are licensed under the Apache License, Version 2.0, whose full text is
identical to this repository's `LICENSE`. None of them ships a `NOTICE` file at the referenced
version.

## Runtime dependencies (L1)

Installed from npm, never copied into the repository; licenses of their whole dependency trees are
enforced by `scripts/license-gate.ts`.

| Package | Version | License | Used by |
|---|---|---|---|
| `hls.js` | 1.7.3 | Apache-2.0 | `@otter-player/engine-adapter-hlsjs` |
| `shaka-player` | 5.2.13 | Apache-2.0 | `@otter-player/engine-adapter-shaka` |
| `mpegts.js` | 1.8.2 | Apache-2.0 | `@otter-player/engine-adapter-mpegts` |

## Vendored and copied code

### hls.js (Apache-2.0)

- Repository: https://github.com/video-dev/hls.js
- Commit: e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de (v1.7.3)
- Copyright (c) 2017 Dailymotion (http://www.dailymotion.com)
- Copies (L3):
  - `packages/backend-mse/src/vendor/hls.js`: `src/utils/mediasource-helper.ts` (getMediaSource,
    isManagedMediaSource) and `src/controller/buffer-controller.ts` (removeSourceChildren, addSource).
  - `e2e/vendor/hls.js`: subset of `tests/test-streams.js` (test assets only, not shipped).

### shaka-player (Apache-2.0)

- Repository: https://github.com/shaka-project/shaka-player
- Commit: 2ac882d23750d50c07a483b2786b1cb466398e8e (v5.2.13)
- Copyright 2016 Google LLC
- Copies (L3):
  - `e2e/vendor/shaka-player`: subset of `demo/common/assets.js` (test assets only, not shipped).

<!--
Template:

### <project> (<license>)

- Repository: <url>
- Commit: <40-char sha> (<tag>)
- Copyright <holder>
- Copies (L2 | L3):
  - `<repo-relative dir>`: <upstream files>

<full license text or NOTICE content when it differs from LICENSE>
-->
