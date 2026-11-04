---
"@otter-player/demux-mediabunny": minor
---

demux-mediabunny: AAC in live MPEG-TS is read by the adapter, each PES's frames as soon as the PES has arrived (mediabunny released the last frame of each PES one PES late, a short silence at every PES on surveillance walls); audio from before the first video keyframe is kept, so live audio starts at 0.
