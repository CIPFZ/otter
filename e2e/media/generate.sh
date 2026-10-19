#!/usr/bin/env bash
# Generates the deterministic local test media for the e2e scenario matrix (ADR-003 §8).
# Output is committed so tests never need ffmpeg; rerun only when the media set changes.
#
#   e2e/media/generate.sh
#
# Needs ffmpeg with an H.264 encoder (libx264, or libopenh264 with Cisco's libopenh264 on
# LD_LIBRARY_PATH) and the AAC encoder, plus Shaka Packager (on PATH or $PACKAGER) for the
# encrypted sample. Both are build tools here; nothing of them ships.
# H.264 Constrained Baseline + AAC-LC in fMP4 / TS / FLV is the one combination every target
# browser plays (RESEARCH §2.2).
set -euo pipefail
cd "$(dirname "$0")"

FF=(ffmpeg -y -hide_banner -loglevel error)
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 '; then VC=libx264; else VC=libopenh264; fi

# Test pattern with a running counter + 440 Hz tone. 25 fps, keyframe every second (GOP 25),
# so 2 s segments always start on a keyframe.
SRC_V='testsrc2=size=640x360:rate=25'
SRC_A='sine=frequency=440:sample_rate=48000'
DUR=8
V360=(-c:v "$VC" -b:v 300k -maxrate 300k -g 25 -keyint_min 25 -sc_threshold 0)
AAC=(-c:a aac -b:a 64k -ac 2)

rm -rf vod hls-ts hls-fmp4 dash dash-clearkey flv ts
mkdir -p vod hls-ts hls-fmp4 dash dash-clearkey flv ts

# Progressive files (short video / background video / local file / shorts).
"${FF[@]}" -f lavfi -i "$SRC_V" -f lavfi -i "$SRC_A" -t $DUR "${V360[@]}" "${AAC[@]}" -movflags +faststart vod/progressive.mp4
"${FF[@]}" -f lavfi -i 'testsrc2=size=360x640:rate=25' -f lavfi -i "$SRC_A" -t 6 "${V360[@]}" "${AAC[@]}" -movflags +faststart vod/vertical.mp4

# Two renditions (360p / 180p) shared by the HLS and DASH ladders.
LADDER=(-f lavfi -i "$SRC_V" -f lavfi -i "$SRC_A" -t $DUR
  -filter_complex '[0:v]split=2[a][b];[b]scale=320:180[b2]'
  -map '[a]' -map '[b2]' -map 1:a
  -c:v "$VC" -g 25 -keyint_min 25 -sc_threshold 0
  -b:v:0 300k -maxrate:v:0 300k -b:v:1 120k -maxrate:v:1 120k
  "${AAC[@]}")

# HLS, TS segments, two muxed renditions; WebVTT subtitles added below.
"${FF[@]}" "${LADDER[@]}" -map 1:a -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type mpegts \
  -var_stream_map 'v:0,a:0 v:1,a:1' -master_pl_name master.m3u8 \
  -hls_segment_filename 'hls-ts/v%v_%03d.ts' hls-ts/v%v.m3u8

# HLS, fMP4 (CMAF) segments.
"${FF[@]}" "${LADDER[@]}" -map 1:a -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -var_stream_map 'v:0,a:0 v:1,a:1' -master_pl_name master.m3u8 \
  -hls_fmp4_init_filename 'init.mp4' -hls_segment_filename 'hls-fmp4/v%v_%03d.m4s' hls-fmp4/v%v.m3u8

# Subtitles for both HLS variants: one WebVTT segment, referenced from the master playlist.
for dir in hls-ts hls-fmp4; do
  cat > "$dir/subs.vtt" <<'VTT'
WEBVTT
X-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000

00:00:00.500 --> 00:00:03.500
Otter test subtitle one

00:00:04.000 --> 00:00:07.500
Otter test subtitle two
VTT
  cat > "$dir/subs.m3u8" <<M3U8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:$DUR
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:$DUR.0,
subs.vtt
#EXT-X-ENDLIST
M3U8
  python3 - "$dir/master.m3u8" <<'PY'
import sys
p = sys.argv[1]
lines = open(p).read().splitlines()
out = [lines[0], lines[1] if lines[1].startswith('#EXT-X-VERSION') else '#EXT-X-VERSION:6',
       '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="subs.m3u8"']
for l in lines[1:]:
    if l.startswith('#EXT-X-VERSION'):
        continue
    out.append(l + ',SUBTITLES="subs"' if l.startswith('#EXT-X-STREAM-INF') else l)
open(p, 'w').write('\n'.join(out) + '\n')
PY
done

# DASH, audio and video in separate adaptation sets (Bilibili-style dual SourceBuffer).
DASH=(-f dash -seg_duration 2 -use_template 1 -use_timeline 1 -adaptation_sets 'id=0,streams=v id=1,streams=a')
"${FF[@]}" "${LADDER[@]}" "${DASH[@]}" -init_seg_name 'init-$RepresentationID$.m4s' \
  -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' dash/manifest.mpd

# DASH with ClearKey (CENC aes-ctr). Test-only key, published in keys.json. ffmpeg's fragmented
# CENC output is invalid ("Incorrect number of samples in encryption info"), so ffmpeg only
# encodes the clear renditions and Shaka Packager (BSD, build tool) encrypts and packages them.
KID=0123456789abcdef0123456789abcdef
KEY=fedcba9876543210fedcba9876543210
PACKAGER=${PACKAGER:-$(command -v packager || true)}
[ -n "$PACKAGER" ] || { echo 'Shaka Packager not found (set PACKAGER=/path/to/packager)' >&2; exit 1; }
TMP=$(mktemp -d)
"${FF[@]}" -f lavfi -i "$SRC_V" -t $DUR "${V360[@]}" -an "$TMP/v360.mp4"
"${FF[@]}" -f lavfi -i "$SRC_V" -t $DUR -vf scale=320:180 -c:v "$VC" -b:v 120k -maxrate 120k -g 25 -keyint_min 25 -sc_threshold 0 -an "$TMP/v180.mp4"
"${FF[@]}" -f lavfi -i "$SRC_A" -t $DUR "${AAC[@]}" -vn "$TMP/a.mp4"
(cd dash-clearkey && "$PACKAGER" \
  "in=$TMP/v360.mp4,stream=video,init_segment=v360/init.mp4,segment_template=v360/\$Number\$.m4s" \
  "in=$TMP/v180.mp4,stream=video,init_segment=v180/init.mp4,segment_template=v180/\$Number\$.m4s" \
  "in=$TMP/a.mp4,stream=audio,init_segment=audio/init.mp4,segment_template=audio/\$Number\$.m4s" \
  --enable_raw_key_encryption --keys "label=:key_id=$KID:key=$KEY" --protection_scheme cenc \
  --protection_systems CommonSystem --clear_lead 0 --segment_duration 2 \
  --generate_static_live_mpd --mpd_output manifest.mpd --quiet)
rm -rf "$TMP"
cat > keys.json <<JSON
{ "dash-clearkey": { "kid": "$KID", "key": "$KEY", "scheme": "cenc-aes-ctr", "note": "public test key, never use for real content" } }
JSON

# FLV (VOD file and source of the paced local live stream) and MPEG-TS.
"${FF[@]}" -f lavfi -i "$SRC_V" -f lavfi -i "$SRC_A" -t 10 "${V360[@]}" "${AAC[@]}" -f flv flv/clip.flv
"${FF[@]}" -f lavfi -i "$SRC_V" -f lavfi -i "$SRC_A" -t $DUR "${V360[@]}" "${AAC[@]}" -f mpegts ts/clip.ts
# Video-only TS (cameras): mpegts.js never reports complete media info without an audio track.
"${FF[@]}" -f lavfi -i "$SRC_V" -t $DUR "${V360[@]}" -an -f mpegts ts/clip-video-only.ts

# Quiet demo picture for the UI review screenshots (docs/reports/M2.5.md): slow dark gradients,
# 720p / 360p fMP4 HLS ladder with one subtitle. Not used by the scenario matrix.
rm -rf demo && mkdir -p demo
DEMO_SRC='gradients=s=1280x720:c0=0x0b1a2b:c1=0x1f4f63:c2=0x2c3e50:c3=0x16222e:speed=0.004:n=4,format=yuv420p'
"${FF[@]}" -f lavfi -i "$DEMO_SRC" -t 12 -c:v "$VC" -b:v 1200k -g 25 demo/src720.mp4
"${FF[@]}" -i demo/src720.mp4 -vf scale=640:360 -c:v "$VC" -b:v 400k -g 25 demo/src360.mp4
for r in 720 360; do
  "${FF[@]}" -i demo/src$r.mp4 -c copy -f hls -hls_time 4 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "init$r.mp4" -hls_segment_filename "demo/v${r}_%03d.m4s" demo/v$r.m3u8
done
rm demo/src720.mp4 demo/src360.mp4
cat > demo/master.m3u8 <<'M3U8'
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="subs.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1300000,RESOLUTION=1280x720,CODECS="avc1.42c01f",SUBTITLES="subs"
v720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=640x360,CODECS="avc1.42c01e",SUBTITLES="subs"
v360.m3u8
M3U8
printf 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n00:00:00.500 --> 00:00:12.000\nThe tide comes in slowly tonight\n' > demo/subs.vtt
printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:12.0,\nsubs.vtt\n#EXT-X-ENDLIST\n' > demo/subs.m3u8

# Seek-preview thumbnails (VTT sprite, I-frame playlist) next to hls-fmp4.
./generate-thumbnails.sh

du -sh . && find . -type f | sort | sed 's/^/  /' | head -80
