#!/bin/sh
# Band masks for e2e/danmaku-mask.spec.ts (ADR-012 §6): 30 s at 30 fps over the numbered ladder;
# frame n's mask is the vertical band k = n mod 30 (one thirtieth of the width), opaque = subject.
# - mask-band.webm: VP9 with alpha (yuva420p, alpha_mode=1), 160x90, all-intra (-g 1: the mask
#   reader seeks per frame).
# - mask-band.json: the same as SVG frames ({frames: [{time, svg}]}, viewBox 30 x 1).
#   FFMPEG=/path/to/ffmpeg sh e2e/media/generate-danmaku-mask.sh   (needs libvpx-vp9)
set -e
cd "$(dirname "$0")/danmaku"
"${FFMPEG:-ffmpeg}" -y -hide_banner -loglevel error -f lavfi -i "color=c=white:s=160x90:r=30:d=30,format=yuva420p" \
  -vf "geq=lum='lum(X,Y)':cb=128:cr=128:a='if(between(X,floor(mod(N,30)*160/30),floor(mod(N,30)*160/30)+4),255,0)'" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -g 1 -b:v 200k -deadline realtime -cpu-used 8 -auto-alt-ref 0 -an mask-band.webm
python3 - <<'PY'
import json
frames = [{"time": round(n / 30, 6), "svg": f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 1"><path d="M{n % 30} 0h1v1h-1z"/></svg>'} for n in range(900)]
json.dump({"frames": frames}, open("mask-band.json", "w"), separators=(",", ":"))
PY
