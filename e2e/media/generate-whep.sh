#!/usr/bin/env bash
# Video for the local WHEP fixture (e2e/whep.ts, format-whep): 4 s of testsrc2 at 320x180, 25 fps,
# VP8 (every browser's WebRTC decodes it; headless Firefox has no OpenH264) in an IVF file, one
# keyframe per second. The fixture loops it as RTP, continuing timestamps. Called by generate.sh.
#   whep/clip.ivf
#   whep/tone.ogg   4 s of a 440 Hz tone, Opus in Ogg, 20 ms packets (the audio track, also looped)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p whep
ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x180:rate=25 -t 4 \
  -c:v libvpx -deadline realtime -cpu-used 8 -b:v 300k -g 25 -keyint_min 25 -auto-alt-ref 0 -lag-in-frames 0 \
  -f ivf whep/clip.ivf
ffmpeg -y -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 4 \
  -c:a libopus -b:a 48k -ac 2 -frame_duration 20 -application audio whep/tone.ogg
