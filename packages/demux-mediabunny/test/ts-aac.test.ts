import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adtsFrames, createAacReader, type AacFrame } from '../src/ts-aac.js';

const clip = new Uint8Array(readFileSync(new URL('../../../e2e/media/ts/clip.ts', import.meta.url)));

const read = (bytes: Uint8Array, chunk: number): { frames: AacFrame[]; afterPes: number[] } => {
  const frames: AacFrame[] = [];
  const afterPes: number[] = [];
  const r = createAacReader((f) => {
    frames.push(...f);
    afterPes.push(f.length);
  });
  for (let o = 0; o < bytes.length; o += chunk) r.push(bytes.subarray(o, o + chunk));
  r.end();
  return { frames, afterPes };
};

describe('AAC from live MPEG-TS (M6 F16)', () => {
  it('reads every ADTS frame of the clip, timed PTS + i × 1024 / rate, whatever the chunking', () => {
    const a = read(clip, 188 * 7);
    const b = read(clip, 1000);
    expect(a.frames.length).toBeGreaterThan(300);
    expect(b.frames.map((f) => f.time)).toEqual(a.frames.map((f) => f.time));
    expect(a.frames[0]?.time).toBeCloseTo(1.4, 6);
    for (let i = 1; i < a.frames.length; i++) expect((a.frames[i] as AacFrame).time - (a.frames[i - 1] as AacFrame).time).toBeCloseTo(1024 / 48000, 6);
    expect(a.frames.every((f) => f.data[0] === 0xff && f.duration === 1024 / 48000)).toBe(true);
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
    expect(read(zeroed, 4096).frames.map((f) => f.time)).toEqual(read(clip, 4096).frames.map((f) => f.time));
  });

  it('skips bytes that are not an ADTS frame; stops at a truncated one', () => {
    const one = read(clip, 4096).frames[0] as AacFrame;
    const payload = new Uint8Array([0x00, 0x12, ...one.data, ...one.data.subarray(0, 5)]);
    const frames = adtsFrames(payload, 10);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.time).toBe(10);
  });
});
