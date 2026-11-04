---
"@otter-player/format-hls": minor
---

format-hls: the hls.js and Shaka adapters load with their first use (a stream the own engine hands over, a DRM source), not with the page: the short-VOD first load is 25.5 KB gzip (was 30.3).
