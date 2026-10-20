#!/usr/bin/env bash
# Frame-numbered clips for frame-accurate seek (format-file, ADR-008 §2): 12 s at 30 fps with one
# keyframe every 90 frames (3 s), so a seek decodes from an earlier keyframe and drops frames.
# Every frame carries its own number in the top-left corner: 10 blocks of 48x48 px, bit i at
# x = 48 i (least significant first), white = 1, black = 0. Below it, testsrc2 keeps the encoder
# busy with motion. Called by generate.sh; rerun alone with the same tool requirements.
#   frames/h264.mp4             H.264 (constrained baseline) + AAC
#   frames/h264-video-only.mp4  H.264 without audio (the clock is still the AudioContext)
#   frames/vp9.webm             VP9 + Opus
set -euo pipefail
cd "$(dirname "$0")"

FF=(ffmpeg -y -hide_banner -loglevel error)
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 '; then VC=(-c:v libx264 -profile:v baseline -bf 0); else VC=(-c:v libopenh264 -rc_mode bitrate); fi
GOP=(-g 90 -keyint_min 90 -sc_threshold 0)
BITS=10
BLOCK=48
# Luma: the number's bits on the block row; chroma (half resolution) neutral there.
BIT="mod(floor(N/pow(2,floor(X/$BLOCK))),2)"
LUM="if(lt(Y,$BLOCK)*lt(X,$((BITS * BLOCK))),if($BIT,235,16),lum(X,Y))"
CB="if(lt(Y,$((BLOCK / 2)))*lt(X,$((BITS * BLOCK / 2))),128,cb(X,Y))"
CR="if(lt(Y,$((BLOCK / 2)))*lt(X,$((BITS * BLOCK / 2))),128,cr(X,Y))"
VF="format=yuv420p,geq=lum='$LUM':cb='$CB':cr='$CR'"
VIDEO=(-f lavfi -i 'testsrc2=size=640x360:rate=30')
AUDIO=(-f lavfi -i 'sine=frequency=440:sample_rate=48000')

rm -rf frames
mkdir -p frames
"${FF[@]}" "${VIDEO[@]}" "${AUDIO[@]}" -t 12 -vf "$VF" "${VC[@]}" -b:v 300k -maxrate 300k "${GOP[@]}" \
  -c:a aac -b:a 32k -ac 1 -movflags +faststart frames/h264.mp4
"${FF[@]}" "${VIDEO[@]}" -t 12 -vf "$VF" "${VC[@]}" -b:v 300k -maxrate 300k "${GOP[@]}" -an -movflags +faststart frames/h264-video-only.mp4
"${FF[@]}" "${VIDEO[@]}" "${AUDIO[@]}" -t 12 -vf "$VF" -c:v libvpx-vp9 -b:v 300k -deadline good -cpu-used 4 -row-mt 1 "${GOP[@]}" \
  -c:a libopus -b:a 32k -ac 1 frames/vp9.webm
