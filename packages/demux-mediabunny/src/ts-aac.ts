// AAC (ADTS) from a live MPEG-TS byte stream, read by the adapter itself (M6 F16). Measured: on a
// live stream mediabunny returns an audio PES only once the next PES of its PID starts, and the
// last packet of each PES only once the PES after that starts (it needs the next packet for a
// duration); CI's underruns were each at a PES's last frame. Here a PES is complete when its
// PES_packet_length is reached (or, without one, at the next PES start), and its ADTS frames go out
// at once, timed PTS + i × 1024 / sample rate. The frames are the bytes mediabunny would hand out
// (whole ADTS frames, header included).
// - A frame cut by the end of a PES is carried into the next one and goes out with it, timed by
//   the PES it started in.
// - Times are on mediabunny's timeline (its video is the other half of the stream): PTS is
//   normalised as mediabunny does (anchored at the first PTS of the stream, one 33-bit wrap), and
//   unwrapped beyond that at a 2^32-tick jump.
// - A frame is taken only when the next one starts with a sync word too (or the PES ends with it).
// - Only ADTS AAC (stream type 0x0f): `streamType` tells the caller what else the PMT carries.

const TS = 188;
// Literals, not expressions: a module-level `2 ** 33` is a top-level side effect to the gate.
/** 2^33: PTS wrap. */
const MODULUS = 8_589_934_592;
/** 2^32: a jump this large between timestamps is a wrap. */
const HALF = 4_294_967_296;
const TIMESCALE = 90_000;
/** mediabunny's anchor tolerance (60 s × 90 kHz): earlier timestamps count as wrapped. */
const TOLERANCE = 5_400_000;

/** One AAC frame: its time in seconds on the stream's timeline, its duration, the ADTS frame. */
export interface AacFrame {
  readonly time: number;
  readonly duration: number;
  readonly data: Uint8Array;
}

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** An ADTS header at `i`: its sample rate and frame length, or undefined. */
function adtsHeader(b: Uint8Array, i: number): { rate: number; length: number } | undefined {
  if (i + 7 > b.length || b[i] !== 0xff || ((b[i + 1] as number) & 0xf6) !== 0xf0) return undefined;
  const rate = SAMPLE_RATES[((b[i + 2] as number) >> 2) & 0x0f];
  const length = (((b[i + 3] as number) & 0x03) << 11) | ((b[i + 4] as number) << 3) | ((b[i + 5] as number) >> 5);
  return rate === undefined || length < 7 ? undefined : { rate, length };
}

const syncAt = (b: Uint8Array, i: number): boolean => b[i] === 0xff && ((b[i + 1] as number) & 0xf6) === 0xf0;

/**
 * The ADTS frames of a buffer: whole frames, each followed by a sync word or the buffer's end, and
 * where an incomplete last frame (or header) starts, if any. `timeAt(start, n)`: the time of the
 * n-th frame found, which starts at byte `start`.
 */
export function adtsFrames(b: Uint8Array, timeAt: (start: number, n: number) => number): { frames: AacFrame[]; rest: number | undefined } {
  const frames: AacFrame[] = [];
  let i = 0;
  while (i < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    if (i + 7 > b.length) {
      // A header cut by the end: carried if it can still be one.
      return { frames, rest: i + 1 >= b.length || ((b[i + 1] as number) & 0xf6) === 0xf0 ? i : undefined };
    }
    const h = adtsHeader(b, i);
    if (h === undefined) {
      i++;
      continue;
    }
    const end = i + h.length;
    if (end > b.length) return { frames, rest: i };
    // A false sync word inside the data would read a frame whose end is not the next one's start.
    if (end + 2 <= b.length && !syncAt(b, end)) {
      i++;
      continue;
    }
    if (end + 1 === b.length && b[end] !== 0xff) {
      i++;
      continue;
    }
    const duration = 1024 / h.rate;
    frames.push({ time: timeAt(i, frames.length), duration, data: b.slice(i, end) });
    i = end;
  }
  return { frames, rest: undefined };
}

/**
 * PTS ticks to seconds on mediabunny's timeline: its normalisation (anchored at the first PTS seen,
 * timestamps more than 60 s before it count as wrapped, an anchor within 60 s of 2^33 counts as
 * negative), then continuous across further wraps (a jump of more than 2^32 ticks is a wrap).
 */
export function createPtsClock(): { anchor(ticks: number): void; seconds(ticks: number): number } {
  let reference: number | undefined;
  let offset = 0;
  let extra = 0;
  let last: number | undefined;
  const anchor = (ticks: number): void => {
    if (reference !== undefined) return;
    reference = ticks - TOLERANCE;
    offset = ticks >= MODULUS - TOLERANCE ? -MODULUS : MODULUS;
  };
  return {
    anchor,
    seconds(ticks) {
      anchor(ticks);
      const r = reference as number;
      let v = (offset < 0 && ticks >= r) || (offset > 0 && ticks < r) ? ticks + offset : ticks;
      v += extra;
      if (last !== undefined && v - last < -HALF) {
        extra += MODULUS;
        v += MODULUS;
      } else if (last !== undefined && v - last > HALF) {
        extra -= MODULUS;
        v -= MODULUS;
      }
      last = v;
      return v / TIMESCALE;
    },
  };
}

export interface AacReader {
  push(bytes: Uint8Array): void;
  end(): void;
  /** The PMT's stream type of `pid` once the PMT is read (undefined: not in it, or the stream ended first). */
  streamType(pid: number): Promise<number | undefined>;
  /** Every elementary stream of the PMT (pid → stream type), once read. */
  streams(): Promise<ReadonlyMap<number, number>>;
}

/** One audio PID's reading state. */
interface Lane {
  pes: { parts: Uint8Array[]; size: number; want: number | undefined; time: number | undefined } | undefined;
  /** A frame (or header) cut by the end of the last PES: its bytes and its time. */
  carry: { bytes: Uint8Array; time: number } | undefined;
  /** End of the last frame out (a PES without PTS continues from it). */
  lastEnd: number | undefined;
}

/**
 * A push parser: `push(bytes)` as the stream arrives, `onFrames(frames, pid)` gets each PES's frames
 * once it is complete, for every ADTS AAC stream (stream type 0x0f) of the PMT; the caller picks
 * its PID (mediabunny's track id). Streams of other types yield nothing.
 */
export function createAacReader(onFrames: (frames: AacFrame[], pid: number) => void): AacReader {
  let rest = new Uint8Array(0);
  let pmtPid: number | undefined;
  const lanes = new Map<number, Lane>();
  const types = new Map<number, number>();
  let pmtRead = false;
  const pmtWaiters: (() => void)[] = [];
  const pmtDone = (): void => {
    pmtRead = true;
    for (const w of pmtWaiters.splice(0)) w();
  };
  // One clock for the stream: every PID's PTS share mediabunny's anchor.
  const clock = createPtsClock();
  let ended = false;

  const finish = (pid: number, lane: Lane): void => {
    if (lane.pes === undefined) return;
    const p = lane.pes;
    lane.pes = undefined;
    const carry = lane.carry;
    const prefix = carry?.bytes.length ?? 0;
    const buf = new Uint8Array(prefix + p.size);
    if (carry !== undefined) buf.set(carry.bytes);
    let o = prefix;
    for (const part of p.parts) {
      buf.set(part, o);
      o += part.length;
    }
    const carried = carry;
    lane.carry = undefined;
    const start = p.time ?? lane.lastEnd;
    if (start === undefined) return;
    let own = 0;
    let before = 0;
    const duration = (n: number, at: number): number => {
      const h = adtsHeader(buf, at);
      return n * (1024 / (h?.rate ?? 48000));
    };
    let { frames, rest: cut } = adtsFrames(buf, (at) => {
      if (at < prefix && carried !== undefined) return carried.time + duration(before++, at);
      return start + duration(own++, at);
    });
    if (carried !== undefined && cut !== undefined && cut < prefix) {
      // The carried frame does not end in this PES either: not a frame (a false sync word at the
      // end of the last PES). Dropped; this PES is read on its own.
      own = 0;
      ({ frames, rest: cut } = adtsFrames(buf.subarray(prefix), (at) => start + duration(own++, at + prefix)));
      if (cut !== undefined) cut += prefix;
    }
    if (cut !== undefined) {
      const t = cut < prefix && carried !== undefined ? carried.time + duration(before, cut) : start + duration(own, cut);
      lane.carry = { bytes: buf.slice(cut), time: t };
    }
    const lastFrame = frames.at(-1);
    if (lastFrame !== undefined) lane.lastEnd = lastFrame.time + lastFrame.duration;
    if (frames.length > 0) onFrames(frames, pid);
  };

  const add = (pid: number, lane: Lane, bytes: Uint8Array): void => {
    const pes = lane.pes;
    if (pes === undefined) return;
    const take = pes.want === undefined ? bytes : bytes.subarray(0, Math.max(0, pes.want - pes.size));
    pes.parts.push(take.slice());
    pes.size += take.length;
    if (pes.want !== undefined && pes.size >= pes.want) finish(pid, lane);
  };

  const section = (body: Uint8Array): Uint8Array => body.subarray(1 + (body[0] as number)); // after pointer_field

  /** The PTS of a PES header at `body`, in ticks, if it has one. */
  const ptsOf = (body: Uint8Array): number | undefined => {
    if (body.length < 14 || ((body[7] as number) & 0x80) === 0) return undefined;
    const t = (k: number): number => body[k] as number;
    return (t(9) & 0x0e) * 536870912 + t(10) * 4194304 + (t(11) & 0xfe) * 16384 + t(12) * 128 + (t(13) >> 1);
  };

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
      const s = section(body);
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
    if (id === pmtPid) {
      if (!pusi || pmtRead) return;
      // PMT: every elementary stream; each ADTS AAC one gets a lane.
      const s = section(body);
      const len = (((s[1] as number) & 0x0f) << 8) | (s[2] as number);
      const infoLen = (((s[10] as number) & 0x0f) << 8) | (s[11] as number);
      for (let i = 12 + infoLen; i + 5 <= 3 + len - 4; ) {
        const es = (((s[i + 1] as number) & 0x1f) << 8) | (s[i + 2] as number);
        types.set(es, s[i] as number);
        if (s[i] === 0x0f) lanes.set(es, { pes: undefined, carry: undefined, lastEnd: undefined });
        i += 5 + ((((s[i + 3] as number) & 0x0f) << 8) | (s[i + 4] as number));
      }
      pmtDone();
      return;
    }
    const isPesStart = pusi && body[0] === 0 && body[1] === 0 && body[2] === 1;
    // The timeline's anchor: the stream's first PTS, whatever the PID (as mediabunny anchors).
    if (isPesStart) {
      const ticks = ptsOf(body);
      if (ticks !== undefined) clock.anchor(ticks);
    }
    const lane = lanes.get(id);
    if (lane === undefined) return;
    if (pusi) {
      // Without a PES_packet_length, a PES ends where the next one starts.
      finish(id, lane);
      if (!isPesStart) return;
      const length = ((body[4] as number) << 8) | (body[5] as number);
      const headerLength = body[8] as number;
      const ticks = ptsOf(body);
      lane.pes = { parts: [], size: 0, want: length === 0 ? undefined : length - 3 - headerLength, time: ticks === undefined ? undefined : clock.seconds(ticks) };
      add(id, lane, body.subarray(9 + headerLength));
      return;
    }
    add(id, lane, body);
  };

  const waitPmt = (): Promise<void> => (pmtRead || ended ? Promise.resolve() : new Promise((r) => pmtWaiters.push(r)));

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
      for (const [pid, lane] of lanes) finish(pid, lane);
      ended = true;
      for (const w of pmtWaiters.splice(0)) w();
    },
    async streamType(id) {
      await waitPmt();
      return types.get(id);
    },
    async streams() {
      await waitPmt();
      return types;
    },
  };
}

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};
