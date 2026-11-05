---
"@otter-player/backend-webcodecs": minor
"@otter-player/presets": minor
"@otter-player/demux-mediabunny": patch
---

Live sources with sound on WebCodecs start once the decoded audio is 300 ms ahead of the clock (a minimal, fixed jitter buffer): the first frame still shows at once, the clock starts at the latest 1 s after it, and audio running dry while playing is reported, not waited for. New option `liveAudioLeadMs` on `createWebCodecsBackendFactory` and on the surveillance preset (`0`: start at once). Before, a stream joined in the middle of a GOP (audio muxed ~0.3 s behind the video, as ffmpeg writes it) ran dry at every audio PES. Live MPEG-TS AAC frames now come out as soon as each frame is in, not when its PES is complete.
