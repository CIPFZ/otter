// A small MPEG-TS writer for the live TS tests: PAT, PMT, and PES split into 188-byte packets, so a
// test can cut audio PES where it wants (frames across PES, junk in a PES, any stream type).

/** One elementary stream of the PMT. */
export interface TsStream {
  readonly pid: number;
  readonly type: number;
}

const packet = (pid: number, start: boolean, cc: number, payload: Uint8Array): Uint8Array => {
  const p = new Uint8Array(188).fill(0xff);
  p[0] = 0x47;
  p[1] = (start ? 0x40 : 0) | ((pid >> 8) & 0x1f);
  p[2] = pid & 0xff;
  const room = 184;
  if (payload.length >= room) {
    p[3] = 0x10 | (cc & 0x0f);
    p.set(payload.subarray(0, room), 4);
    return p;
  }
  // Adaptation field stuffing before a short payload.
  p[3] = 0x30 | (cc & 0x0f);
  const af = room - payload.length - 1;
  p[4] = af;
  if (af > 0) p[5] = 0x00;
  p.set(payload, 188 - payload.length);
  return p;
};

const section = (bytes: number[]): Uint8Array => {
  // pointer_field, the section with its length, a zero CRC (the reader under test does not check it).
  const body = [...bytes, 0, 0, 0, 0];
  const len = body.length - 3 + 0;
  body[1] = 0xb0 | ((len >> 8) & 0x0f);
  body[2] = len & 0xff;
  return new Uint8Array([0, ...body]);
};

/** PAT + PMT for one program with `streams` (PMT on PID 0x1000). */
export function tables(streams: readonly TsStream[]): Uint8Array[] {
  const pat = section([0x00, 0, 0, 0x00, 0x01, 0xc1, 0, 0, 0x00, 0x01, 0xe0 | 0x10, 0x00]);
  const es = streams.flatMap((s) => [s.type, 0xe0 | (s.pid >> 8), s.pid & 0xff, 0xf0, 0x00]);
  const pmt = section([0x02, 0, 0, 0x00, 0x01, 0xc1, 0, 0, 0xe0 | ((streams[0]?.pid ?? 0x100) >> 8), (streams[0]?.pid ?? 0x100) & 0xff, 0xf0, 0x00, ...es]);
  return [packet(0, true, 0, pat), packet(0x1000, true, 0, pmt)];
}

const ptsBytes = (ticks: number): number[] => {
  const t = Math.round(ticks) % 2 ** 33;
  return [0x21 | (Math.floor(t / 2 ** 29) & 0x0e), Math.floor(t / 2 ** 22) & 0xff, (Math.floor(t / 2 ** 14) & 0xfe) | 1, Math.floor(t / 2 ** 7) & 0xff, ((t % 128) << 1) | 1];
};

/** One PES (stream id 0xc0) with an optional PTS (90 kHz ticks), as TS packets of `pid`. */
export function pes(pid: number, payload: Uint8Array, pts: number | undefined, cc: { n: number }): Uint8Array[] {
  const header = pts === undefined ? [0x80, 0x00, 0x00] : [0x80, 0x80, 0x05, ...ptsBytes(pts)];
  const len = header.length + payload.length;
  const bytes = new Uint8Array([0, 0, 1, 0xc0, (len >> 8) & 0xff, len & 0xff, ...header, ...payload]);
  const out: Uint8Array[] = [];
  for (let o = 0; o < bytes.length; o += 184) out.push(packet(pid, o === 0, cc.n++, bytes.subarray(o, o + 184)));
  return out;
}

export const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** A copy of a TS file with every PES PTS / DTS moved by `ticks` (mod 2^33). */
export function shiftTimestamps(ts: Uint8Array, ticks: number): Uint8Array {
  const out = ts.slice();
  const read = (b: Uint8Array, i: number): number => ((b[i] as number) & 0x0e) * 536870912 + (b[i + 1] as number) * 4194304 + ((b[i + 2] as number) & 0xfe) * 16384 + (b[i + 3] as number) * 128 + ((b[i + 4] as number) >> 1);
  const write = (b: Uint8Array, i: number, value: number): void => {
    const prefix = (b[i] as number) & 0xf0;
    const v = ptsBytes(value);
    b.set([prefix | ((v[0] as number) & 0x0f), ...v.slice(1)], i);
  };
  for (let i = 0; i + 188 <= out.length; i += 188) {
    if (((out[i + 1] as number) & 0x40) === 0) continue;
    const afc = ((out[i + 3] as number) >> 4) & 3;
    const s = i + 4 + ((afc & 2) !== 0 ? 1 + (out[i + 4] as number) : 0);
    if (out[s] !== 0 || out[s + 1] !== 0 || out[s + 2] !== 1) continue;
    const flags = (out[s + 7] as number) >> 6;
    if ((flags & 2) !== 0) write(out, s + 9, (read(out, s + 9) + ticks) % 2 ** 33);
    if (flags === 3) write(out, s + 14, (read(out, s + 14) + ticks) % 2 ** 33);
  }
  return out;
}
