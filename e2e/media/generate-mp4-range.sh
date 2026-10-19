#!/usr/bin/env bash
# MP4 renditions for format-mp4-range (ADR-007 §4): the same 12 s programme at 360p and 180p with
# keyframes on the same timestamps (GOP 25 at 25 fps), so a switch at any keyframe is seamless.
# 360p keeps moov at the end (exercises the tail Range request), 180p is faststart. Called by
# generate.sh; rerun alone with the same tool requirements.
set -euo pipefail
cd "$(dirname "$0")"

FF=(ffmpeg -y -hide_banner -loglevel error)
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 '; then VC=libx264; else VC=libopenh264; fi
GOP=(-g 25 -keyint_min 25 -sc_threshold 0)
AAC=(-c:a aac -b:a 64k -ac 2)

rm -rf mp4-range
mkdir -p mp4-range
"${FF[@]}" -f lavfi -i 'testsrc2=size=640x360:rate=25' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 12 \
  -c:v "$VC" -b:v 300k -maxrate 300k "${GOP[@]}" "${AAC[@]}" mp4-range/360.mp4
"${FF[@]}" -f lavfi -i 'testsrc2=size=640x360:rate=25' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 12 \
  -vf scale=320:180 -c:v "$VC" -b:v 120k -maxrate 120k "${GOP[@]}" "${AAC[@]}" -movflags +faststart mp4-range/180.mp4
