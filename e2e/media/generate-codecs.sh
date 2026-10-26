#!/usr/bin/env bash
# Multi-codec CMAF fixture (ADR-011 §1 batch 3: codec probing, preferences, DASH A/V split):
#   codecs/               one set of segments, two manifests
#     master.m3u8         HLS: H.264 360p + 180p, HEVC 360p, VP9 360p, AV1 360p; audio en / fr
#                         (AAC, separate renditions), WebVTT en / de
#     video.m3u8          the same video variants only
#     h264-audio.m3u8     the H.264 variants with the audio renditions and subtitles
#     (manifest.mpd       DASH over the same segments, M5 batch 3 item 2)
# 6 s, 2 s segments, keyframe every 2 s, testsrc2 with the codec name burnt in. Needs the pinned
# static ffmpeg of generate-frames.sh (libx265, libsvtav1, libvpx-vp9): FFMPEG=<path>.
set -euo pipefail
export SVT_LOG=1
cd "$(dirname "$0")"
FF=("${FFMPEG:-ffmpeg}" -y -hide_banner -loglevel error)
OUT=codecs
rm -rf "$OUT"
mkdir -p "$OUT"
T=6
GOP=(-g 60 -keyint_min 60 -sc_threshold 0 -r 30)
SRC=(-f lavfi -i "testsrc2=size=640x360:rate=30" -t $T)

# One CMAF track per rendition: fragmented MP4 cut every 2 s (init + media segments, numbered from 0).
seg() { # <name> <ffmpeg args...>
  local name=$1
  shift
  "${FF[@]}" "$@" -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
    -hls_fmp4_init_filename "${name}_init.mp4" -hls_segment_filename "$OUT/${name}_%03d.m4s" "$OUT/$name.m3u8"
}
label() { echo "drawtext=text='$1':fontcolor=white:fontsize=40:x=20:y=h-60:box=1:boxcolor=black"; }

seg h264_360 "${SRC[@]}" -vf "$(label H.264)" -c:v libx264 -profile:v main -bf 0 -b:v 400k -maxrate 400k -bufsize 400k "${GOP[@]}" -an
seg h264_180 "${SRC[@]}" -vf "scale=320:180,$(label H.264)" -c:v libx264 -profile:v main -bf 0 -b:v 150k -maxrate 150k -bufsize 150k "${GOP[@]}" -an
seg hevc_360 "${SRC[@]}" -vf "$(label HEVC)" -c:v libx265 -tag:v hvc1 -x265-params "bframes=0:keyint=60:min-keyint=60:scenecut=0:log-level=error" -b:v 300k "${GOP[@]}" -an
seg vp9_360 "${SRC[@]}" -vf "$(label VP9)" -c:v libvpx-vp9 -b:v 300k -deadline realtime -cpu-used 8 -row-mt 1 "${GOP[@]}" -an
seg av1_360 "${SRC[@]}" -vf "$(label AV1)" -c:v libsvtav1 -preset 10 -b:v 250k -svtav1-params "keyint=60:scd=0" "${GOP[@]}" -an
seg audio_en -f lavfi -i "sine=frequency=440:sample_rate=48000" -t $T -c:a aac -b:a 64k -ac 2
seg audio_fr -f lavfi -i "sine=frequency=660:sample_rate=48000" -t $T -c:a aac -b:a 64k -ac 2

# ffmpeg writes the init next to the playlist's directory name: move it into the fixture.
for f in "$OUT"/*.m3u8; do
  n=$(basename "$f" .m3u8)
  [ -f "${n}_init.mp4" ] && mv "${n}_init.mp4" "$OUT/"
done

vtt() { # <lang> <text>
  printf 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000\n\n00:00:00.000 --> 00:00:06.000\n%s\n' "$2" > "$OUT/subs_$1.vtt"
  printf '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6.0,\nsubs_%s.vtt\n#EXT-X-ENDLIST\n' "$1" > "$OUT/subs_$1.m3u8"
}
vtt en 'English subtitle'
vtt de 'Deutscher Untertitel'

cat > "$OUT/master.m3u8" <<M3U
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio_en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Français",LANGUAGE="fr",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="audio_fr.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="subs_en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Deutsch",LANGUAGE="de",DEFAULT=NO,AUTOSELECT=YES,URI="subs_de.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
h264_360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=320x180,CODECS="avc1.4d400d,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
h264_180.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="hvc1.1.6.L63.90,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
hevc_360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="vp09.00.21.08,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
vp9_360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=640x360,CODECS="av01.0.01M.08,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
av1_360.m3u8
M3U
# The same video variants without audio or subtitles: the own CMAF-HLS engine's codec choice
# without separate audio renditions (M5 batch 3 report).
grep -v -e '^#EXT-X-MEDIA' "$OUT/master.m3u8" | sed -e 's/,mp4a.40.2//' -e 's/,AUDIO="aud",SUBTITLES="subs"//' > "$OUT/video.m3u8"
# H.264 only, with the separate audio renditions (en / fr) and subtitles: the own engine with
# separate audio, no codec choice involved.
awk '/^#EXT-X-STREAM-INF/ && !/avc1/ { skip = 1; next } skip { skip = 0; next } { print }' "$OUT/master.m3u8" > "$OUT/h264-audio.m3u8"
echo "codecs: $(du -sh "$OUT" | cut -f1)"
