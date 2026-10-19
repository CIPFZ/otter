// Own pipeline transmuxers on the e2e test media (ADR-007 §2): FLV and MPEG-TS in, fMP4 out.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createCea608Decoder, type Cea608Cue } from '../src/captions/cea608.js';
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

describe('CEA-608 from SEI (ADR-007 §6)', () => {
  for (const [name, create, file] of [
    ['MPEG-TS', createTsTransmuxer, 'cc/clip.ts'],
    ['FLV', createFlvTransmuxer, 'cc/clip.flv'],
  ] as const) {
    it(`${name}: cc_data on the fragments' clock decodes to the caption shown from 1 s to 6 s`, () => {
      const results = feed(create(), media(file), 16_384);
      const captions = results.flatMap((r) => r.captions);
      expect(captions).toHaveLength(2);
      // Same clock as the video fragments: 1 s and 6 s after the first frame.
      const firstVideo = results.flatMap((r) => r.fragments).find((f) => f.type === 'video')?.startPTS ?? 0;
      expect((captions[0]?.time ?? 0) - firstVideo).toBeCloseTo(1, 1);
      expect((captions[1]?.time ?? 0) - firstVideo).toBeCloseTo(6, 1);
      const cues: Cea608Cue[] = [];
      const d = createCea608Decoder((channel, c) => channel === 1 && cues.push(...c));
      for (const c of captions) d.push(c.time, c.data);
      expect(cues.map((c) => c.text)).toEqual(['OTTER 608']);
      expect((cues[0]?.endTime ?? 0) - (cues[0]?.startTime ?? 0)).toBeCloseTo(5, 1);
    });
  }
});

describe('TS transmuxer input views', () => {
  it('chunks that are views into a larger buffer give the same output as copies (vendored hls.js fix)', () => {
    const data = media('cc/clip.ts');
    const run = (copy: boolean) => {
      const t = createTsTransmuxer();
      const out: TransmuxResult[] = [];
      for (let o = 0; o < data.byteLength; o += 16_384) out.push(t.push(copy ? data.slice(o, o + 16_384) : data.subarray(o, o + 16_384)));
      out.push(t.flush());
      return { fragments: out.flatMap((r) => r.fragments).length, captions: out.flatMap((r) => r.captions).map((c) => c.time.toFixed(3)) };
    };
    expect(run(false)).toEqual(run(true));
  });
});

