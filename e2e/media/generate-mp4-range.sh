#!/usr/bin/env bash
# MP4 renditions for format-mp4-range (ADR-007 §4): the same 30 s programme at 360p and 180p with
# keyframes on the same timestamps (GOP 25 at 25 fps), so a switch at any keyframe is seamless.
# 360p keeps moov at the end (exercises the tail Range request), 180p is faststart. 30 s at low
# bitrates: a switch only applies to what is not buffered yet, and one Range read adds ~4 s, so a
# short clip can be buffered whole before a second switch (flaky e2e). Called by generate.sh;
# rerun alone with the same tool requirements.
set -euo pipefail
cd "$(dirname "$0")"

FF=(ffmpeg -y -hide_banner -loglevel error)
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 '; then VC=libx264; else VC=libopenh264; fi
GOP=(-g 25 -keyint_min 25 -sc_threshold 0)
# testsrc (simpler than testsrc2) and openh264's bitrate mode keep the files small.
RC=(); [ "$VC" = libopenh264 ] && RC=(-rc_mode bitrate)
AAC=(-c:a aac -b:a 32k -ac 1)

rm -rf mp4-range
mkdir -p mp4-range
"${FF[@]}" -f lavfi -i 'testsrc=size=640x360:rate=25' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 30 \
  -c:v "$VC" "${RC[@]}" -b:v 160k -maxrate 160k "${GOP[@]}" "${AAC[@]}" mp4-range/360.mp4
"${FF[@]}" -f lavfi -i 'testsrc=size=640x360:rate=25' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 30 \
  -vf scale=320:180 -c:v "$VC" "${RC[@]}" -b:v 70k -maxrate 70k "${GOP[@]}" "${AAC[@]}" -movflags +faststart mp4-range/180.mp4
