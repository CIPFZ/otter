#!/usr/bin/env bash
# CEA-608 closed captions in H.264 SEI (ADR-007 §6): MPEG-TS and FLV files whose video carries
# A/53 cc_data (user_data_registered_itu_t_t35, "GA94") with one pop-on caption, "OTTER 608",
# shown at 1 s (End Of Caption) and erased at 6 s (Erase Displayed Memory), on CC1. ffmpeg
# cannot author 608, so the SEI NAL units are inserted into the Annex-B stream by the Python step
# below and the result is muxed with -c copy (input -r 25: raw H.264 has no timestamps, and
# -framerate is ignored for it). Called by generate.sh; rerun alone with the same tools.
set -euo pipefail
cd "$(dirname "$0")"

FF=(ffmpeg -y -hide_banner -loglevel error)
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q ' libx264 '; then VC=libx264; else VC=libopenh264; fi
TMP=$(mktemp -d)
rm -rf cc
mkdir -p cc

"${FF[@]}" -f lavfi -i 'testsrc2=size=640x360:rate=25' -t 8 -c:v "$VC" -b:v 300k -g 25 -keyint_min 25 -sc_threshold 0 -bsf:v h264_mp4toannexb -f h264 "$TMP/v.h264"
"${FF[@]}" -f lavfi -i 'sine=frequency=440:sample_rate=48000' -t 8 -c:a aac -b:a 64k -ac 2 "$TMP/a.m4a"

python3 - "$TMP/v.h264" "$TMP/v-cc.h264" <<'PY'
import sys

src, dst = sys.argv[1], sys.argv[2]
data = open(src, 'rb').read()

def odd(b):
    """CEA-608 bytes carry odd parity in bit 7."""
    return b | (0 if bin(b).count('1') % 2 else 0x80)

def text(s):
    pairs, raw = [], [ord(c) for c in s]
    if len(raw) % 2: raw.append(0)
    for i in range(0, len(raw), 2):
        pairs.append((odd(raw[i]), odd(raw[i + 1]) if raw[i + 1] else 0x80))
    return pairs

RCL, PAC15, EOC, EDM = (0x14, 0x20), (0x14, 0x70), (0x14, 0x2f), (0x14, 0x2c)
ctl = lambda p: (odd(p[0]), odd(p[1]))
# Frame index (25 fps) -> byte pairs on field 1 (CC1). Control codes doubled, as broadcast.
CAPTIONS = {
    25: [ctl(RCL), ctl(RCL), ctl(PAC15), ctl(PAC15), *text('OTTER 608'), ctl(EOC), ctl(EOC)],
    150: [ctl(EDM), ctl(EDM)],
}

def sei(pairs):
    cc = bytes([0x40 | len(pairs), 0xff]) + b''.join(bytes([0xfc, a, b]) for a, b in pairs) + b'\xff'
    payload = b'\xb5\x00\x31GA94\x03' + cc
    body = bytes([4, len(payload)]) + payload + b'\x80'
    # Emulation prevention: 00 00 0x (x <= 3) -> 00 00 03 0x.
    out, zeros = bytearray(), 0
    for b in body:
        if zeros >= 2 and b <= 3:
            out.append(3)
            zeros = 0
        out.append(b)
        zeros = zeros + 1 if b == 0 else 0
    return b'\x00\x00\x00\x01\x06' + bytes(out)

# Split Annex-B into NAL units (start codes kept with the unit).
starts, i = [], 0
while True:
    i = data.find(b'\x00\x00\x01', i)
    if i < 0: break
    starts.append(i - 1 if i > 0 and data[i - 1] == 0 else i)
    i += 3
units = [data[s:e] for s, e in zip(starts, starts[1:] + [len(data)])]

out, frame = bytearray(), -1
for u in units:
    head = u.index(b'\x00\x00\x01') + 3
    nal_type = u[head] & 0x1f
    # first_mb_in_slice == 0 (ue(v) '1' -> top bit set): a new picture starts here.
    if nal_type in (1, 5) and u[head + 1] & 0x80:
        frame += 1
        if frame in CAPTIONS: out += sei(CAPTIONS[frame])
    out += u
open(dst, 'wb').write(out)
print(f'{frame + 1} frames, SEI on {sorted(CAPTIONS)}')
PY

"${FF[@]}" -r 25 -i "$TMP/v-cc.h264" -i "$TMP/a.m4a" -c copy -f mpegts cc/clip.ts
"${FF[@]}" -r 25 -i "$TMP/v-cc.h264" -i "$TMP/a.m4a" -c copy -f flv cc/clip.flv
rm -rf "$TMP"
