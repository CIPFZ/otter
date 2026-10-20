// TS demuxer input views (Otter local change, UPSTREAM.json localChanges): chunks that are
// Uint8Array views into a larger ArrayBuffer (byteOffset > 0, buffer longer than the view) must
// demux exactly like standalone copies. Upstream builds the remainder from data.buffer and ignores
// the view's offset, which duplicates frames and CEA-608 user data. hlsjs-byteoffset-evidence.md.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEMUX_CONFIG, logger, TSDemuxer } from '../src/index.ts';

const media = (p: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../e2e/media/${p}`, import.meta.url)));
const meta = { sn: 0, iframe: false, duration: 8 };
const CHUNK = 16_384;

/** The file inside a larger buffer: 4 KB of padding before and after it. */
function embedded(file: Uint8Array): Uint8Array {
  const big = new Uint8Array(file.byteLength + 8192).fill(0xaa);
  big.set(file, 4096);
  return big.subarray(4096, 4096 + file.byteLength);
}

function demuxAll(file: Uint8Array, views: boolean) {
  const demuxer = new TSDemuxer({ emit: () => true }, DEFAULT_DEMUX_CONFIG, { mpeg: false, mp3: false, ac3: false }, logger);
  demuxer.resetInitSegment(undefined, 'mp4a.40.2', 'avc1.42e01e', 8, null, meta);
  let last: ReturnType<typeof demuxer.demux> | undefined;
  for (let o = 0; o < file.byteLength; o += CHUNK) {
    const chunk = views ? file.subarray(o, o + CHUNK) : file.slice(o, o + CHUNK);
    last = demuxer.demux(chunk, 0, meta, false, false);
  }
  const flushed = demuxer.flush(0, meta) as NonNullable<typeof last>;
  return {
    video: flushed.videoTrack.samples.map((s) => (s as { dts: number }).dts),
    audio: flushed.audioTrack.samples.length,
    captions: flushed.textTrack.samples.filter((s) => s.type === 3).map((s) => s.pts),
  };
}

describe('TS demuxer: input chunks that are views into a larger buffer', () => {
  for (const file of ['cc/clip.ts', 'ts/clip.ts']) {
    it(`${file}: views give the same frames and cc_data as copies, no duplicates`, () => {
      const data = embedded(media(file));
      expect(data.byteOffset).toBeGreaterThan(0);
      expect(data.buffer.byteLength).toBeGreaterThan(data.byteLength);
      const copies = demuxAll(data, false);
      const views = demuxAll(data, true);
      expect(views).toEqual(copies);
      // 8 s at 25 fps, every DTS once and in order.
      expect(views.video).toHaveLength(200);
      expect(new Set(views.video).size).toBe(200);
      expect(views.video.every((d, i) => i === 0 || d > (views.video[i - 1] as number))).toBe(true);
      if (file === 'cc/clip.ts') expect(views.captions).toHaveLength(2);
    });
  }
});
