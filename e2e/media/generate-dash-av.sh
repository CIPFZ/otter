#!/usr/bin/env bash
# DASH with separate audio and video (ADR-011 batch 3 item 2, SPEC §19 B 站式弹幕站), for Shaka:
#   dash-av/manifest.mpd   video AdaptationSet: H.264 640x360 / 480x270 / 320x180 at about
#                          900 / 450 / 180 kbps; audio AdaptationSets English (440 Hz) and
#                          French (660 Hz), 64 kbps AAC each
#   dash-av/codecs.mpd     the same plus an HEVC and an AV1 AdaptationSet (640x360), for the
#                          codec-family filter (ADR-011 §5)
# 12 s, 2 s segments, keyframes every 2 s on the same frames. Needs the pinned static ffmpeg of
# generate-frames.sh (libx265, libsvtav1): FFMPEG=<path>.
set -euo pipefail
cd "$(dirname "$0")"
export SVT_LOG=1
FF=("${FFMPEG:-ffmpeg}" -y -hide_banner -loglevel error)
OUT=dash-av
rm -rf "$OUT" && mkdir -p "$OUT"
GOP=(-g 60 -keyint_min 60 -sc_threshold 0 -r 30)
"${FF[@]}" \
  -f lavfi -i 'testsrc2=size=640x360:rate=30' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' \
  -f lavfi -i 'sine=frequency=660:sample_rate=48000' -t 12 \
  -filter_complex '[0:v]split=5[a][b][c][d][e];[b]scale=480:270[b2];[c]scale=320:180[c2]' \
  -map '[a]' -map '[b2]' -map '[c2]' -map '[d]' -map '[e]' -map 1:a -map 2:a -t 12 \
  -c:v:0 libx264 -profile:v:0 main -b:v:0 900k -maxrate:v:0 900k -bufsize:v:0 900k \
  -c:v:1 libx264 -profile:v:1 main -b:v:1 450k -maxrate:v:1 450k -bufsize:v:1 450k \
  -c:v:2 libx264 -profile:v:2 main -b:v:2 180k -maxrate:v:2 180k -bufsize:v:2 180k \
  -c:v:3 libx265 -tag:v:3 hvc1 -b:v:3 500k -x265-params 'bframes=0:keyint=60:min-keyint=60:scenecut=0:log-level=error' \
  -c:v:4 libsvtav1 -preset:v:4 10 -b:v:4 400k -svtav1-params:v:4 'keyint=60:scd=0' \
  -bf 0 "${GOP[@]}" \
  -c:a aac -b:a 64k -ac 2 -metadata:s:a:0 language=eng -metadata:s:a:1 language=fra \
  -f dash -seg_duration 2 -use_template 1 -use_timeline 0 \
  -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
  -adaptation_sets 'id=0,streams=0,1,2 id=1,streams=3 id=2,streams=4 id=3,streams=5 id=4,streams=6' \
  "$OUT/codecs.mpd"
# manifest.mpd: without the HEVC and AV1 AdaptationSets.
python3 - "$OUT" <<'PY'
import re, sys
d = sys.argv[1]
s = open(f'{d}/codecs.mpd').read()
s = re.sub(r'\s*<AdaptationSet id="[12]".*?</AdaptationSet>', '', s, flags=re.S)
open(f'{d}/manifest.mpd', 'w').write(s)
PY
du -sh "$OUT"
