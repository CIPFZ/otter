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
| `@svta/cml-cmcd` | 2.8.2 | Apache-2.0 | `@otter-player/media` (CMCD encoding, loaded on demand) |
| `@svta/cml-structured-field-values` | 1.1.6 | Apache-2.0 | `@otter-player/media` (peer of `@svta/cml-cmcd`) |
| `@svta/cml-utils` | 1.6.1 | Apache-2.0 | `@otter-player/media` (peer of `@svta/cml-cmcd`) |
| `media-captions` | 1.0.4 | MIT | `@otter-player/text` (WebVTT / SRT parser, loaded on demand) |
| `imsc` | 1.1.5 | BSD-2-Clause | `@otter-player/text` (IMSC1 / TTML, loaded on demand) |
| `sax` | 1.2.1 | ISC | `@otter-player/text` (dependency of `imsc`) |
| `lucide` | 1.59.0 | ISC (part of the icons MIT, from Feather) | `@otter-player/ui-core` (icon set, pre-bundled into the dist; license text below) |

### Lucide license (ISC; Feather-derived icons MIT)

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

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
  - `vendor/hls.js` (L2, ADR-007): `src/demux/tsdemuxer.ts` with the ADTS / MPEG audio and AVC / HEVC
    parsers, `src/remux/mp4-remuxer.ts`, `mp4-generator.ts`, `aac-helper.ts` and the type / utility
    modules they need (full list and local changes in `vendor/hls.js/UPSTREAM.json`). Pre-bundled
    into `@otter-player/pipeline`.
  - `packages/text/src/vendor/hls.js`: `src/utils/cea-608-parser.ts` and `src/utils/output-filter.ts`
    (CEA-608 closed captions). The parser is hls.js' port of dash.js' cea608-parser and keeps the
    DASH Industry Forum BSD-3-Clause notice (see dash.js below).

### mpegts.js (Apache-2.0)

- Repository: https://github.com/xqq/mpegts.js
- Commit: 791bac89e2ea8cbebe7f7ba247c3b342c09418cc (v1.8.2)
- Copyright (C) 2016 Bilibili. All Rights Reserved.
- Copies (L2):
  - `vendor/mpegts.js` (ADR-007): `src/demux/flv-demuxer.js`, `amf-parser.js`, `sps-parser.js`,
    `h265-parser.js`, `exp-golomb.js`, `demux-errors.js`, `src/core/media-info.js`,
    `src/utils/utf8-conv.js`, `src/utils/typedarray-equality.ts`, ported to TypeScript (list and
    local changes in `vendor/mpegts.js/UPSTREAM.json`). Pre-bundled into `@otter-player/pipeline`.
- Copies (L3):
  - `packages/pipeline/src/vendor/mpegts.js`: `src/player/live-latency-chaser.ts`,
    `live-latency-synchronizer.ts` and `startup-stall-jumper.ts` (Copyright (C) 2023 zheng qian),
    rewritten as pure decision functions for the LiveController (ADR-007 §3).

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
