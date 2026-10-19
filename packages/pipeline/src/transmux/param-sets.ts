// avcC / hvcC (ISO/IEC 14496-15) parsing: FLV carries the decoder configuration record, hls.js'
// remuxer wants the raw parameter sets and the NAL length size (ADR-007 §2).

export interface AvcConfig {
  readonly lengthSize: number;
  readonly sps: Uint8Array[];
  readonly pps: Uint8Array[];
}

export interface HevcConfig {
  readonly lengthSize: number;
  readonly vps: Uint8Array[];
  readonly sps: Uint8Array[];
  readonly pps: Uint8Array[];
}

const u16 = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);

/** AVCDecoderConfigurationRecord. */
export function parseAvcC(rec: Uint8Array): AvcConfig {
  if (rec.byteLength < 7 || rec[0] !== 1) throw new Error('avcC: bad record');
  const lengthSize = ((rec[4] ?? 0) & 3) + 1;
  let o = 5;
  const sps: Uint8Array[] = [];
  const pps: Uint8Array[] = [];
  const spsCount = (rec[o++] ?? 0) & 0x1f;
  for (let i = 0; i < spsCount; i++) {
    const len = u16(rec, o);
    sps.push(rec.subarray(o + 2, o + 2 + len));
    o += 2 + len;
  }
  const ppsCount = rec[o++] ?? 0;
  for (let i = 0; i < ppsCount; i++) {
    const len = u16(rec, o);
    pps.push(rec.subarray(o + 2, o + 2 + len));
    o += 2 + len;
  }
  if (o > rec.byteLength || sps.length === 0 || pps.length === 0) throw new Error('avcC: truncated record');
  return { lengthSize, sps, pps };
}

/** HEVCDecoderConfigurationRecord: parameter set arrays by NAL unit type (32 VPS, 33 SPS, 34 PPS). */
export function parseHvcC(rec: Uint8Array): HevcConfig {
  if (rec.byteLength < 23 || rec[0] !== 1) throw new Error('hvcC: bad record');
  const lengthSize = ((rec[21] ?? 0) & 3) + 1;
  const sets: Record<number, Uint8Array[]> = { 32: [], 33: [], 34: [] };
  let o = 23;
  const arrays = rec[22] ?? 0;
  for (let a = 0; a < arrays; a++) {
    const type = (rec[o] ?? 0) & 0x3f;
    const count = u16(rec, o + 1);
    o += 3;
    for (let i = 0; i < count; i++) {
      const len = u16(rec, o);
      sets[type]?.push(rec.subarray(o + 2, o + 2 + len));
      o += 2 + len;
    }
  }
  const vps = sets[32] ?? [];
  const sps = sets[33] ?? [];
  const pps = sets[34] ?? [];
  if (o > rec.byteLength || vps.length === 0 || sps.length === 0 || pps.length === 0) throw new Error('hvcC: truncated record');
  return { lengthSize, vps, sps, pps };
}
