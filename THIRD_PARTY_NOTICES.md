# Third-Party Notices

Otter is licensed under Apache-2.0 (see `LICENSE`). This file lists third-party code that is
vendored (REUSE L2) or copied at file level (REUSE L3) into this repository, and the third-party
runtime dependencies (REUSE L1) of the published packages. Each vendored entry must match a
`UPSTREAM.json` and the `// Derived from <project>@<commit> <path>, <license>` header of every
derived file; `scripts/check-vendor.ts` enforces this in CI.

Unless noted otherwise, the projects below are licensed under the Apache License, Version 2.0,
whose full text is identical to this repository's `LICENSE`; none of them ships a `NOTICE` file at
the referenced version. BSD-licensed projects carry their full license text in their entry.

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
  - `packages/pipeline/src/vendor/hls.js`: `src/utils/ewma.ts` and
    `src/utils/ewma-bandwidth-estimator.ts` (ABR bandwidth estimate).

### shaka-player (Apache-2.0)

- Repository: https://github.com/shaka-project/shaka-player
- Commit: 2ac882d23750d50c07a483b2786b1cb466398e8e (v5.2.13)
- Copyright 2016 Google LLC
- Copies (L3):
  - `e2e/vendor/shaka-player`: subset of `demo/common/assets.js` (test assets only, not shipped).

### dash.js (BSD-3-Clause)

- Repository: https://github.com/Dash-Industry-Forum/dash.js
- Commit: a9a8542cd7e6257116be4046ebf16ac49e1cec91 (v5.2.1)
- Copyright (c) 2013, 2016 Dash Industry Forum. All rights reserved.
- Copies (L3):
  - `packages/pipeline/src/vendor/dash.js`: `src/streaming/rules/abr/ThroughputRule.js`,
    `InsufficientBufferRule.js`, `BolaRule.js` (ABR rules; each file keeps its upstream header).

```
The copyright in this software is being made available under the BSD License, included below.
This software may be subject to other third party and contributor rights, including patent
rights, and no such rights are granted under this license.

Copyright (c) 2015, Dash Industry Forum.
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted
provided that the following conditions are met:
* Redistributions of source code must retain the above copyright notice, this list of conditions
  and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of
  conditions and the following disclaimer in the documentation and/or other materials provided
  with the distribution.
* Neither the name of the Dash Industry Forum nor the names of its contributors may be used to
  endorse or promote products derived from this software without specific prior written
  permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER
IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT
OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

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
