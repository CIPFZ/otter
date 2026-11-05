import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAacReader, createPtsClock, type AacFrame } from '../src/ts-aac.js';
import { join, pes, tables } from './ts-writer.js';

const clip = new Uint8Array(readFileSync(new URL('../../../e2e/media/ts/clip.ts', import.meta.url)));

/** Every frame the reader gives, pushing `bytes` in chunks of `chunk`. */
const read = (bytes: Uint8Array, chunk: number): AacFrame[] => {
  const frames: AacFrame[] = [];
  const r = createAacReader((f) => void frames.push(...f));
  for (let o = 0; o < bytes.length; o += chunk) r.push(bytes.subarray(o, o + chunk));
  r.end();
  return frames;
};

const reference = read(clip, 4096);
const hex = (f: AacFrame): string => Buffer.from(f.data).toString('hex');

/**
 * A TS stream of the clip's ADTS frames, cut into PES of `pesBytes` (frames across PES), with
 * `junk` bytes between two frames if given.
 */
function recut(pesBytes: number, junk?: { after: number; bytes: number[] }): Uint8Array {
  // Byte offset → time of the frame starting there.
  const starts = new Map<number, number>();
  const pieces: Uint8Array[] = [];
  let o = 0;
  reference.forEach((f, i) => {
    starts.set(o, f.time);
    pieces.push(f.data);
    o += f.data.length;
    if (junk?.after === i) {
      pieces.push(new Uint8Array(junk.bytes));
      o += junk.bytes.length;
    }
  });
  const all = join(pieces);
  const cc = { n: 0 };
  const parts = tables([{ pid: 0x100, type: 0x0f }]);
  for (let at = 0; at < all.length; at += pesBytes) {
    const end = Math.min(all.length, at + pesBytes);
    // The PES's PTS: its first frame that starts in it.
    let first: number | undefined;
    for (let b = at; b < end && first === undefined; b++) first = starts.get(b);
    parts.push(...pes(0x100, all.subarray(at, end), first === undefined ? undefined : first * 90_000, cc));
  }
  return join(parts);
}

describe('AAC from live MPEG-TS (M6 F16)', () => {
  it('reads every ADTS frame of the clip, timed PTS + i × 1024 / rate, whatever the chunking', () => {
    const b = read(clip, 1000);
    expect(reference.length).toBeGreaterThan(300);
    expect(b.map((f) => f.time)).toEqual(reference.map((f) => f.time));
    expect(reference[0]?.time).toBeCloseTo(1.4, 6);
    for (let i = 1; i < reference.length; i++) expect((reference[i] as AacFrame).time - (reference[i - 1] as AacFrame).time).toBeCloseTo(1024 / 48000, 6);
  });

  it('a PES without PES_packet_length ends at the next PES start of its PID', () => {
    const zeroed = clip.slice();
    for (let i = 0; i + 188 <= zeroed.length; i += 188) {
      const pid = (((zeroed[i + 1] as number) & 0x1f) << 8) | (zeroed[i + 2] as number);
      const pusi = ((zeroed[i + 1] as number) & 0x40) !== 0;
      const afc = ((zeroed[i + 3] as number) >> 4) & 3;
      const start = i + 4 + ((afc & 2) !== 0 ? 1 + (zeroed[i + 4] as number) : 0);
      if (pid === 257 && pusi && zeroed[start] === 0 && zeroed[start + 1] === 0 && zeroed[start + 2] === 1) {
        zeroed[start + 4] = 0;
        zeroed[start + 5] = 0;
      }
    }
    expect(read(zeroed, 4096).map((f) => f.time)).toEqual(reference.map((f) => f.time));
  });

  it('frames cut by the end of a PES: carried into the next PES, timed by the PES they started in', () => {
    // PES of 1000 bytes: nearly every PES ends inside a frame (frames are 120-240 bytes).
    const frames = read(recut(1000), 188 * 3);
    expect(frames.length).toBe(reference.length);
    expect(frames.map(hex)).toEqual(reference.map(hex));
    frames.forEach((f, i) => expect(f.time).toBeCloseTo((reference[i] as AacFrame).time, 4));
  });

  it('a false sync word: a frame is taken only when the next one starts with a sync word', () => {
    // Junk between the 10th and 11th frame that reads as an ADTS header (48 kHz, 64 bytes) whose
    // end is no sync word.
    const junk = [0xff, 0xf1, 0x4c, 0x80, 0x08, 0x1f, 0xfc, ...Array<number>(80).fill(0x11)];
    const frames = read(recut(1000, { after: 9, bytes: junk }), 188 * 3);
    expect(frames.map(hex)).toEqual(reference.map(hex));
  });

  it('pushed one TS packet at a time: each frame is out once the next one’s sync word is in, before its PES ends (owner 2026-11-05)', () => {
    // Every audio PES of the clip: the byte its last TS packet ends at.
    const pesEnds: number[] = [];
    let last: number | undefined;
    for (let i = 0; i + 188 <= clip.length; i += 188) {
      const pid = (((clip[i + 1] as number) & 0x1f) << 8) | (clip[i + 2] as number);
      if (pid !== 257) continue;
      if (((clip[i + 1] as number) & 0x40) !== 0 && last !== undefined) pesEnds.push(last);
      last = i + 188;
    }
    // When (bytes pushed) each frame came out.
    const outAt: number[] = [];
    let pushed = 0;
    const r = createAacReader((f) => {
      for (let k = 0; k < f.length; k++) outAt.push(pushed);
    });
    for (; pushed < clip.length; ) {
      pushed += 188;
      r.push(clip.subarray(pushed - 188, pushed));
    }
    r.end();
    expect(outAt).toHaveLength(reference.length);
    // Per PES (16 frames), its first frame is out before the PES's last packet is in, and the
    // frames come out spread over its packets, not all at its end.
    const firsts = pesEnds.map((end, k) => ({ end, first: outAt[k * 16] as number, distinct: new Set(outAt.slice(k * 16, k * 16 + 16)).size }));
    expect(firsts.length).toBeGreaterThan(20);
    for (const p of firsts) {
      expect(p.first, `PES ending at byte ${p.end}`).toBeLessThan(p.end);
      expect(p.distinct).toBeGreaterThan(4);
    }
  });

  it('PTS across the 33-bit wrap: mediabunny’s normalisation, then continuous over further wraps', () => {
    const M = 2 ** 33;
    // Anchored within 60 s below 2^33 (mediabunny: those count as negative).
    const near = createPtsClock();
    expect(near.seconds(M - 90_000)).toBeCloseTo(-1, 6);
    expect(near.seconds(90_000)).toBeCloseTo(1, 6);
    // Anchored at 0: a later wrap continues, and so does the one after it (mediabunny stops there).
    const zero = createPtsClock();
    const times: number[] = [];
    for (let t = 0; t < 3 * M; t += 2 ** 30) times.push(zero.seconds(t % M));
    for (let i = 1; i < times.length; i++) expect((times[i] as number) - (times[i - 1] as number)).toBeCloseTo(2 ** 30 / 90_000, 3);
    // Anchored elsewhere: timestamps more than 60 s before the anchor have wrapped.
    const mid = createPtsClock();
    mid.anchor(10 * 90_000);
    expect(mid.seconds(10 * 90_000)).toBeCloseTo(10, 6);
  });
});
