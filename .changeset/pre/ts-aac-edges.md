---
"@otter-player/demux-mediabunny": minor
"@otter-player/engine-pipeline": minor
"@otter-player/format-ts": minor
---

Live MPEG-TS audio: AAC frames cut by a PES boundary, PTS wrap-around (on mediabunny's timeline), false sync words; audio other than ADTS AAC stays on mediabunny's path with a non-fatal `tsAudioFallback` (LATM: no sound). Live FLV and TS keep audio timed at or after the first video keyframe whichever arrived first.
