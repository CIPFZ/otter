#!/usr/bin/env bash
# Frame-numbered clips for frame-accurate seek (format-file, ADR-008 §2): 12 s at 30 fps with one
# keyframe every 90 frames (3 s), so a seek decodes from an earlier keyframe and drops frames.
# Every frame carries its own number in the top-left corner: 10 blocks of 48x48 px, bit i at
# x = 48 i (least significant first), white = 1, black = 0. Below it, testsrc2 keeps the encoder
# busy with motion. Called by generate.sh; rerun alone with the same tool requirements.
#   frames/h264.mp4             H.264 (constrained baseline) + AAC
#   frames/h264-video-only.mp4  H.264 without audio (the clock is still the AudioContext)
#   frames/vp9.webm             VP9 + Opus
#   frames/hevc-720p.mp4        HEVC 1280x720 (hvc1), no B-frames, keyframe every 60 frames, no
#                               audio: the surveillance-camera case (multi-view, WASM decoding);
#                               blocks scale with the picture (96 px at 1280 wide)
#   frames/hls-hevc/            the same clip as HLS fMP4 (2 s segments): surveillance-style HEVC
#                               HLS that MSE cannot play here (WebCodecs / WASM through format-hls)
# HEVC needs libx265, which the distro ffmpeg lacks: a pinned BtbN static build is downloaded (and
# checked) into $FFMPEG_STATIC_DIR, default ~/.cache/otter/ffmpeg-static.
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

# Pinned static ffmpeg with libx265 (BtbN FFmpeg-Builds, GPL, linux64).
STATIC_TAG=autobuild-2026-10-19-13-06
STATIC_NAME=ffmpeg-n8.1.3-18-g46d899d7a0-linux64-gpl-8.1
STATIC_SHA256=cc546852e535193e6d30a1f18cb90daa84e8ff320ceac6c6f5b514a1fba67079
STATIC_DIR=${FFMPEG_STATIC_DIR:-$HOME/.cache/otter/ffmpeg-static}
STATIC_FFMPEG=$STATIC_DIR/$STATIC_NAME/bin/ffmpeg
if [ ! -x "$STATIC_FFMPEG" ]; then
  mkdir -p "$STATIC_DIR"
  curl -fsSL -o "$STATIC_DIR/$STATIC_NAME.tar.xz" "https://github.com/BtbN/FFmpeg-Builds/releases/download/$STATIC_TAG/$STATIC_NAME.tar.xz"
  echo "$STATIC_SHA256  $STATIC_DIR/$STATIC_NAME.tar.xz" | sha256sum -c -
  tar -xJf "$STATIC_DIR/$STATIC_NAME.tar.xz" -C "$STATIC_DIR"
fi

rm -rf frames
mkdir -p frames
"${FF[@]}" "${VIDEO[@]}" "${AUDIO[@]}" -t 12 -vf "$VF" "${VC[@]}" -b:v 300k -maxrate 300k "${GOP[@]}" \
  -c:a aac -b:a 32k -ac 1 -movflags +faststart frames/h264.mp4
"${FF[@]}" "${VIDEO[@]}" -t 12 -vf "$VF" "${VC[@]}" -b:v 300k -maxrate 300k "${GOP[@]}" -an -movflags +faststart frames/h264-video-only.mp4
"${FF[@]}" "${VIDEO[@]}" "${AUDIO[@]}" -t 12 -vf "$VF" -c:v libvpx-vp9 -b:v 300k -deadline good -cpu-used 4 -row-mt 1 "${GOP[@]}" \
  -c:a libopus -b:a 32k -ac 1 frames/vp9.webm

# 720p HEVC: the same numbering, scaled (96 px blocks, chroma 48).
HB=96
HBIT="mod(floor(N/pow(2,floor(X/$HB))),2)"
HLUM="if(lt(Y,$HB)*lt(X,$((BITS * HB))),if($HBIT,235,16),lum(X,Y))"
HCB="if(lt(Y,$((HB / 2)))*lt(X,$((BITS * HB / 2))),128,cb(X,Y))"
HCR="if(lt(Y,$((HB / 2)))*lt(X,$((BITS * HB / 2))),128,cr(X,Y))"
"$STATIC_FFMPEG" -y -hide_banner -loglevel error -f lavfi -i 'testsrc2=size=1280x720:rate=30' -t 10 \
  -vf "format=yuv420p,geq=lum='$HLUM':cb='$HCB':cr='$HCR'" -c:v libx265 -tag:v hvc1 -preset fast \
  -x265-params "keyint=60:min-keyint=60:scenecut=0:bframes=0:vbv-maxrate=1200:vbv-bufsize=1200:log-level=error" -b:v 1000k \
  -an -movflags +faststart frames/hevc-720p.mp4
mkdir -p frames/hls-hevc
"$STATIC_FFMPEG" -y -hide_banner -loglevel error -i frames/hevc-720p.mp4 -c copy -tag:v hvc1 -f hls -hls_time 2 -hls_playlist_type vod \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename 'frames/hls-hevc/seg_%03d.m4s' \
  -master_pl_name master.m3u8 frames/hls-hevc/media.m3u8
