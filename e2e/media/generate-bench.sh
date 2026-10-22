#!/usr/bin/env bash
# Benchmark ladder for bench-hls.spec.ts (own CMAF-HLS engine vs hls.js, ADR-011 §1): 60 s, three
# renditions with muxed AAC, CBR so the bitrates hold on test content: 1280x720 at 2.4 Mbps,
# 854x480 at 1.2 Mbps, 640x360 at 0.6 Mbps (+128 kbps audio each), 2 s segments with keyframes on
# the same frames. Not committed (about 30 MB): run this before OTTER_BENCH=1. Needs libx264 (the
# pinned BtbN static ffmpeg of generate-frames.sh, or a distro build with it).
#   bench/ladder/master.m3u8, v{0,1,2}.m3u8, init_{0,1,2}.mp4, v{0,1,2}_NNN.m4s
set -euo pipefail
cd "$(dirname "$0")"
FFMPEG=${FFMPEG:-$(ls "${FFMPEG_STATIC_DIR:-$HOME/.cache/otter/ffmpeg-static}"/*/bin/ffmpeg 2>/dev/null | head -1)}
FFMPEG=${FFMPEG:-ffmpeg}
OUT=bench/ladder
rm -rf "$OUT" && mkdir -p "$OUT"
CBR=(-x264-params "nal-hrd=cbr:force-cfr=1:keyint=60:min-keyint=60:scenecut=0")
"$FFMPEG" -y -hide_banner -loglevel error \
  -f lavfi -i 'testsrc2=size=1280x720:rate=30' -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 60 \
  -filter_complex '[0:v]split=3[a][b][c];[b]scale=854:480[b2];[c]scale=640:360[c2]' \
  -map '[a]' -map '[b2]' -map '[c2]' -map 1:a -map 1:a -map 1:a \
  -c:v libx264 -profile:v main -preset veryfast -bf 0 -g 60 -keyint_min 60 -sc_threshold 0 "${CBR[@]}" \
  -b:v:0 2400k -minrate:v:0 2400k -maxrate:v:0 2400k -bufsize:v:0 2400k \
  -b:v:1 1200k -minrate:v:1 1200k -maxrate:v:1 1200k -bufsize:v:1 1200k \
  -b:v:2 600k -minrate:v:2 600k -maxrate:v:2 600k -bufsize:v:2 600k \
  -c:a aac -b:a 128k -ac 2 \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 -hls_fmp4_init_filename 'init_%v.mp4' \
  -hls_segment_filename "$OUT/v%v_%03d.m4s" -master_pl_name master.m3u8 \
  -var_stream_map 'v:0,a:0 v:1,a:1 v:2,a:2' "$OUT/v%v.m3u8"
du -sh "$OUT"
