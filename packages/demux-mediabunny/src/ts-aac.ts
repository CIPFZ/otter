// AAC (ADTS) from a live MPEG-TS byte stream, read by the adapter itself (M6 F16). mediabunny reads
// a PES only once the next PES of its PID starts, and hands a packet out only once it has the next
// one (to compute its duration); on a live stream the last AAC frame of each PES then waits for the
// PES after next (measured on the e2e stream: ~0.34 s late, an underrun at every such frame on CI).
// Here a PES is complete when its PES_packet_length is reached (or, without one, at the next PES
// start), and every ADTS frame in it goes out at once, timed PTS + i × 1024 / sample rate. The
// frames are the same bytes mediabunny would hand out (whole ADTS frames, header included).

const TS = 188;

/** One AAC frame: its time in seconds on the stream's PTS clock, its duration, the ADTS frame. */
export interface AacFrame {
  readonly time: number;
  readonly duration: number;
  readonly data: Uint8Array;
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** The ADTS frames of one PES payload. */
export function adtsFrames(payload: Uint8Array, pts: number): AacFrame[] {
  const out: AacFrame[] = [];
  let i = 0;
  let n = 0;
  while (i + 7 <= payload.length) {
    if (payload[i] !== 0xff || ((payload[i + 1] as number) & 0xf6) !== 0xf0) {
      i++;
      continue;
    }
    const rate = SAMPLE_RATES[((payload[i + 2] as number) >> 2) & 0x0f];
    const length = (((payload[i + 3] as number) & 0x03) << 11) | ((payload[i + 4] as number) << 3) | ((payload[i + 5] as number) >> 5);
    if (rate === undefined || length < 7 || i + length > payload.length) break;
    const duration = 1024 / rate;
    out.push({ time: pts + n * duration, duration, data: payload.slice(i, i + length) });
    n++;
    i += length;
  }
  return out;
}

/**
 * A push parser: `push(bytes)` as the stream arrives, `onFrames` gets each PES's frames once it is
 * complete. `pid`: the audio PID (mediabunny's track id); undefined: the first ADTS stream of the PMT.
 */
export function createAacReader(onFrames: (frames: AacFrame[]) => void, pid?: number): { push(bytes: Uint8Array): void; end(): void } {
  let rest = new Uint8Array(0);
  let pmtPid: number | undefined;
  let audioPid = pid;
  let pes: { parts: Uint8Array[]; size: number; want: number | undefined; pts: number } | undefined;

  const finish = (): void => {
    if (pes === undefined) return;
    const payload = new Uint8Array(pes.size);
    let o = 0;
    for (const p of pes.parts) {
      payload.set(p, o);
      o += p.length;
    }
    const frames = adtsFrames(payload, pes.pts);
    pes = undefined;
    if (frames.length > 0) onFrames(frames);
  };

  const add = (bytes: Uint8Array): void => {
    if (pes === undefined) return;
    const take = pes.want === undefined ? bytes : bytes.subarray(0, Math.max(0, pes.want - pes.size));
    pes.parts.push(take.slice());
    pes.size += take.length;
    if (pes.want !== undefined && pes.size >= pes.want) finish();
  };

  const section = (p: Uint8Array, at: number): Uint8Array => p.subarray(at + 1 + (p[at] as number)); // after pointer_field

  const packet = (p: Uint8Array): void => {
    const pusi = ((p[1] as number) & 0x40) !== 0;
    const id = (((p[1] as number) & 0x1f) << 8) | (p[2] as number);
    const afc = ((p[3] as number) >> 4) & 0x03;
    if ((afc & 0x01) === 0) return;
    const start = 4 + ((afc & 0x02) !== 0 ? 1 + (p[4] as number) : 0);
    if (start >= TS) return;
    const body = p.subarray(start);
    if (id === 0 && pusi && pmtPid === undefined) {
      // PAT: the first program's PMT.
      const s = section(body, 0);
      const len = (((s[1] as number) & 0x0f) << 8) | (s[2] as number);
      for (let i = 8; i + 4 <= 3 + len - 4; i += 4) {
        const program = ((s[i] as number) << 8) | (s[i + 1] as number);
        if (program !== 0) {
          pmtPid = (((s[i + 2] as number) & 0x1f) << 8) | (s[i + 3] as number);
          break;
        }
      }
      return;
    }
    if (id === pmtPid && pusi && audioPid === undefined) {
      // PMT: the first ADTS AAC stream (stream_type 0x0f).
      const s = section(body, 0);
      const len = (((s[1] as number) & 0x0f) << 8) | (s[2] as number);
      const infoLen = (((s[10] as number) & 0x0f) << 8) | (s[11] as number);
      for (let i = 12 + infoLen; i + 5 <= 3 + len - 4; ) {
        const type = s[i] as number;
        const es = (((s[i + 1] as number) & 0x1f) << 8) | (s[i + 2] as number);
        if (type === 0x0f) {
          audioPid = es;
          break;
        }
        i += 5 + ((((s[i + 3] as number) & 0x0f) << 8) | (s[i + 4] as number));
      }
      return;
    }
    if (id !== audioPid) return;
    if (pusi) {
      // Without a PES_packet_length, a PES ends where the next one starts.
      finish();
      if (body[0] !== 0 || body[1] !== 0 || body[2] !== 1) return;
      const length = ((body[4] as number) << 8) | (body[5] as number);
      const headerLength = body[8] as number;
      if (((body[7] as number) & 0x80) === 0) return; // no PTS
      const t = (k: number): number => body[k] as number;
      const pts = ((t(9) & 0x0e) * 536870912 + t(10) * 4194304 + (t(11) & 0xfe) * 16384 + t(12) * 128 + (t(13) >> 1)) / 90000;
      pes = { parts: [], size: 0, want: length === 0 ? undefined : length - 3 - headerLength, pts };
      add(body.subarray(9 + headerLength));
      return;
    }
    add(body);
  };

  return {
    push(bytes) {
      const all = rest.length === 0 ? bytes : concat(rest, bytes);
      let i = 0;
      while (i + TS <= all.length) {
        if (all[i] !== 0x47) {
          i++;
          continue;
        }
        packet(all.subarray(i, i + TS));
        i += TS;
      }
      rest = all.slice(i);
    },
    end() {
      finish();
    },
  };
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
