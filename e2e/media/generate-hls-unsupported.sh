#!/usr/bin/env bash
# HLS streams the own CMAF-HLS engine leaves to hls.js (ADR-010 §2), built from the numbered ladder
# (frames/hls-ladder, 320x180 rendition, 2 s segments). Each master has CODECS, so the reason the
# engine gives is the feature itself. The other two classes use existing fixtures: TS segments
# (hls-ts/) and I-frame playlists (hls-iframes/). Called by generate.sh after generate-frames.sh.
#   hls-unsupported/discontinuity/  EXT-X-DISCONTINUITY between segment 3 and 4 (same media)
#   hls-unsupported/aes128/         segments AES-128-CBC encrypted (key.bin, fixed IV)
#   hls-unsupported/ll-parts/       LL-HLS tags: PART-HOLD-BACK, PART-INF, one whole-segment part each
set -euo pipefail
cd "$(dirname "$0")"
OUT=hls-unsupported
LADDER=frames/hls-ladder
rm -rf "$OUT"
mkdir -p "$OUT"/{discontinuity,aes128,ll-parts}
master() {
  printf '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=160000,RESOLUTION=320x180,CODECS="avc1.42c00d"\nv.m3u8\n' > "$1/master.m3u8"
}
head_lines() { printf '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n'; }

# Discontinuity: the same timeline, but announced as a discontinuity.
master "$OUT/discontinuity"
{
  head_lines
  printf '#EXT-X-MAP:URI="../../%s/init_1.mp4"\n' "$LADDER"
  for n in 0 1 2 3 4 5 6 7; do
    [ "$n" = 4 ] && printf '#EXT-X-DISCONTINUITY\n'
    printf '#EXTINF:2.000000,\n../../%s/v1_%03d.m4s\n' "$LADDER" "$n"
  done
  printf '#EXT-X-ENDLIST\n'
} > "$OUT/discontinuity/v.m3u8"

# AES-128: whole segments encrypted; the init segment stays clear (EXT-X-MAP before EXT-X-KEY).
master "$OUT/aes128"
printf '0123456789abcdef' > "$OUT/aes128/key.bin"
KEY=$(xxd -p "$OUT/aes128/key.bin")
IV=000102030405060708090a0b0c0d0e0f
cp "$LADDER/init_1.mp4" "$OUT/aes128/init.mp4"
{
  head_lines
  printf '#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x%s\n' "$IV"
  for n in 0 1 2 3 4 5 6 7; do
    f=$(printf 'seg_%03d.m4s' "$n")
    openssl enc -aes-128-cbc -K "$KEY" -iv "$IV" -in "$(printf '%s/v1_%03d.m4s' "$LADDER" "$n")" -out "$OUT/aes128/$f"
    printf '#EXTINF:2.000000,\n%s\n' "$f"
  done
  printf '#EXT-X-ENDLIST\n'
} > "$OUT/aes128/v.m3u8"

# LL-HLS: the tags of a low-latency playlist, each part a whole independent segment.
master "$OUT/ll-parts"
{
  head_lines
  printf '#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=6.0\n#EXT-X-PART-INF:PART-TARGET=2.0\n'
  printf '#EXT-X-MAP:URI="../../%s/init_1.mp4"\n' "$LADDER"
  for n in 0 1 2 3 4 5 6 7; do
    f=$(printf '../../%s/v1_%03d.m4s' "$LADDER" "$n")
    printf '#EXT-X-PART:DURATION=2.0,URI="%s",INDEPENDENT=YES\n#EXTINF:2.000000,\n%s\n' "$f" "$f"
  done
  printf '#EXT-X-ENDLIST\n'
} > "$OUT/ll-parts/v.m3u8"
