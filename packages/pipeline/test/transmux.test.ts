// Own pipeline transmuxers on the e2e test media (ADR-007 §2): FLV and MPEG-TS in, fMP4 out.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFlvTransmuxer, createTsTransmuxer, type TransmuxResult } from '../src/transmux/index.js';

const media = (p: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../e2e/media/${p}`, import.meta.url)));

/** Top-level box types. */
function boxes(data: Uint8Array): string[] {
  const out: string[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let o = 0; o + 8 <= data.byteLength; ) {
    const size = view.getUint32(o);
    out.push(String.fromCharCode(...data.subarray(o + 4, o + 8)));
    if (size < 8) break;
    o += size;
  }
  return out;
}

function feed(t: ReturnType<typeof createFlvTransmuxer>, data: Uint8Array, chunk: number): TransmuxResult[] {
  const out: TransmuxResult[] = [];
  for (let o = 0; o < data.byteLength; o += chunk) out.push(t.push(data.subarray(o, o + chunk)));
  out.push(t.flush());
  return out;
}

describe('FLV transmuxer (mpegts.js demuxer + hls.js remuxer)', () => {
  for (const chunk of [1 << 20, 16_384, 1_000]) {
    it(`FLV -> fMP4 in ${chunk}-byte chunks: one init per track, contiguous video covering 10 s`, () => {
      const t = createFlvTransmuxer();
      const results = feed(t, media('flv/clip.flv'), chunk);
      expect(t.errors).toEqual([]);
      const init = results.flatMap((r) => r.init);
      expect(init.map((i) => [i.type, i.mimeType])).toEqual([
        ['video', expect.stringMatching(/^video\/mp4; codecs="avc1\.42/)],
        ['audio', expect.stringMatching(/^audio\/mp4; codecs="mp4a\.40\.[25]"/)],
      ]);
      for (const i of init) expect(boxes(i.data)).toEqual(['ftyp', 'moov']);
      const video = results.flatMap((r) => r.fragments).filter((f) => f.type === 'video');
      expect(video.length).toBeGreaterThan(0);
      for (const f of video) expect(boxes(f.data)).toEqual(['moof', 'mdat']);
      // Contiguous: each fragment starts where the previous one ended.
      for (let i = 1; i < video.length; i++) expect(video[i]?.startDTS).toBeCloseTo(video[i - 1]?.endDTS ?? 0, 3);
      expect(video[0]?.startPTS).toBeLessThan(0.1);
      expect((video.at(-1)?.endPTS ?? 0) - (video[0]?.startPTS ?? 0)).toBeCloseTo(10, 0);
      expect(t.info).toMatchObject({ width: 640, height: 360, hasAudio: true, hasVideo: true });
    });
  }

  it('rejects non-FLV input with a fatal error', () => {
    const t = createFlvTransmuxer();
    t.push(media('ts/clip.ts').subarray(0, 4096));
    expect(t.errors[0]).toMatchObject({ fatal: true, details: 'flvBadHeader' });
  });
});

describe('TS transmuxer (hls.js demuxer + remuxer)', () => {
  it('TS -> fMP4 with audio and video', () => {
    const t = createTsTransmuxer();
    const results = feed(t, media('ts/clip.ts'), 188 * 100);
    expect(t.errors).toEqual([]);
    expect(results.flatMap((r) => r.init).map((i) => i.type)).toEqual(['video', 'audio']);
    const video = results.flatMap((r) => r.fragments).filter((f) => f.type === 'video');
    expect((video.at(-1)?.endPTS ?? 0) - (video[0]?.startPTS ?? 0)).toBeCloseTo(8, 0);
  });
});
