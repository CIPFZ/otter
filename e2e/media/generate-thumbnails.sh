#!/usr/bin/env bash
# Seek-preview thumbnail fixtures (ADR-007 §7), next to the HLS fMP4 sample in ../hls-fmp4:
#   thumbs/        WebVTT sprite: one 160x90 tile per 2 s in a 4x1 JPEG sheet
#   demo/          sprite + WebVTT for the review demo clip
#   hls-iframes/   the same ladder plus an EXT-X-I-FRAME-STREAM-INF rendition (one keyframe per
#                  2 s, 320x180), for hls.js' I-frame player
# testsrc2 draws the frame from its timestamp, so tiles and I-frames show what the main stream
# shows at that time. Called by generate.sh; rerun alone with the same tool requirements.
set -euo pipefail
cd "$(dirname "$0")"

FF=(ffmpeg -y -hide_banner -loglevel error)
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 '; then VC=libx264; else VC=libopenh264; fi
SRC_V='testsrc2=size=640x360:rate=25'
DUR=8

rm -rf thumbs hls-iframes
mkdir -p thumbs hls-iframes

# Sprite sheet: the frames at 0, 2, 4, 6 s, scaled to 160x90, tiled left to right.
"${FF[@]}" -f lavfi -i "$SRC_V" -t $DUR -vf "select='not(mod(n,50))',scale=160:90,tile=4x1" -frames:v 1 -q:v 4 thumbs/sprite.jpg
{
  echo 'WEBVTT'
  for i in 0 1 2 3; do
    printf '\n00:00:%02d.000 --> 00:00:%02d.000\nsprite.jpg#xywh=%d,0,160,90\n' $((i * 2)) $((i * 2 + 2)) $((i * 160))
  done
} > thumbs/thumbs.vtt

# I-frame rendition: one keyframe every 2 s on the original timestamps, one fMP4 segment each.
# ffmpeg's HLS muxer writes a wrong tfdt for the second segment with gaps this large, so the
# frames go into one fragmented MP4 (a fragment per keyframe) that is split into init + segments.
"${FF[@]}" -f lavfi -i 'testsrc2=size=320x180:rate=25' -t $DUR -vf "select='not(mod(n,50))',setpts=N*2/TB" -fps_mode vfr \
  -c:v "$VC" -b:v 200k -g 1 -an -movflags frag_keyframe+empty_moov+default_base_moof hls-iframes/all.mp4
python3 - hls-iframes <<'PY'
import struct, sys
d = sys.argv[1]
b = open(f'{d}/all.mp4', 'rb').read()
boxes, o = [], 0
while o < len(b):
    size, typ = struct.unpack('>I4s', b[o:o + 8])
    boxes.append((typ, b[o:o + size]))
    o += size
open(f'{d}/iframe-init.mp4', 'wb').write(b''.join(x for t, x in boxes if t in (b'ftyp', b'moov')))
frags = [x for t, x in boxes if t in (b'moof', b'mdat')]
lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-I-FRAMES-ONLY', '#EXT-X-MAP:URI="iframe-init.mp4"']
for i in range(0, len(frags), 2):
    name = f'iframe_{i // 2:03d}.m4s'
    open(f'{d}/{name}', 'wb').write(frags[i] + frags[i + 1])
    lines += ['#EXTINF:2.000,', name]
open(f'{d}/iframe.m3u8', 'w').write('\n'.join(lines + ['#EXT-X-ENDLIST']) + '\n')
PY
rm hls-iframes/all.mp4
cat > hls-iframes/master.m3u8 <<'M3U8'
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-STREAM-INF:BANDWIDTH=400400,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
../hls-fmp4/v0.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=202400,RESOLUTION=320x180,CODECS="avc1.42c00c,mp4a.40.2"
../hls-fmp4/v1.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=80000,RESOLUTION=320x180,CODECS="avc1.42c00c",URI="iframe.m3u8"
M3U8

# Sprite for the review demo clip (docs/reports screenshots): a 160x90 tile every 2 s of 12 s.
# init + segments concatenated is a playable fragmented MP4 (ffmpeg's HLS demuxer rejects .m4s).
cat demo/init720.mp4 demo/v720_*.m4s | "${FF[@]}" -i - -vf "select='not(mod(n,50))',scale=160:90,tile=6x1" -frames:v 1 -q:v 4 demo/sprite.jpg
{
  echo 'WEBVTT'
  for i in 0 1 2 3 4 5; do
    printf '\n00:00:%02d.000 --> 00:00:%02d.000\nsprite.jpg#xywh=%d,0,160,90\n' $((i * 2)) $((i * 2 + 2)) $((i * 160))
  done
} > demo/thumbs.vtt
