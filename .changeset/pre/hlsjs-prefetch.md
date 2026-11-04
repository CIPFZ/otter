---
"@otter-player/format-hls": minor
"@otter-player/engine-adapter-hlsjs": minor
---

format-hls prefetches hls.js once the own engine plays (idle, not with Save-Data), so a hand-over does not wait for its download; a live playlist that gains something the own engine leaves to hls.js (EXT-X-DISCONTINUITY …) now hands over at once instead of retrying reloads. New `prefetchHlsJs()` in engine-adapter-hlsjs.
