// The L2 copy works end to end on the e2e test media: MPEG-TS in, fMP4 init + moof/mdat out,
// with the same tracks and timing ffprobe reports for the source file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DEMUX_CONFIG, logger, MP4Remuxer, TSDemuxer, type HlsEventEmitter } from '../src/index.ts';

const media = (p: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../e2e/media/${p}`, import.meta.url)));
const typeSupported = { mpeg: false, mp3: false, ac3: false };
const meta = { sn: 0, iframe: false, duration: 8 };

/** Top-level MP4 boxes of a buffer. */
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

describe('hls.js L2 copy: TS -> fMP4', () => {
  it('demuxes A/V TS and remuxes it into init + fragments', () => {
    const errors: unknown[] = [];
    const observer: HlsEventEmitter = { emit: (_e, _n, data) => (errors.push(data), true) };
    const ts = media('ts/clip.ts');
    expect(TSDemuxer.probe(ts, logger)).toBe(true);
    const demuxer = new TSDemuxer(observer, DEFAULT_DEMUX_CONFIG, typeSupported, logger);
    demuxer.resetInitSegment(undefined, 'mp4a.40.2', 'avc1.42c01e', 8, null, meta);
    const demuxed = demuxer.demux(ts, 0, meta, false, true);
    // flush() returns the same (accumulating) track objects.
    const flushed = demuxer.flush(0, meta) as ReturnType<typeof demuxer.demux>;
    expect(flushed.videoTrack).toBe(demuxed.videoTrack);
    const video = demuxed.videoTrack;
    const audio = demuxed.audioTrack;
    expect(video.codec).toMatch(/^avc1\.42/);
    expect(audio.codec).toBe('mp4a.40.2');
    expect(video.samples.length).toBe(200); // 8 s at 25 fps (ffprobe: 200 frames)

    const remuxer = new MP4Remuxer(observer, DEFAULT_DEMUX_CONFIG, typeSupported, logger);
    const result = remuxer.remux(audio, video, demuxed.id3Track, demuxed.textTrack, 0, true, true, 'main', meta);
    expect(errors).toEqual([]);
    const init = result.initSegment;
    expect(init?.tracks?.video?.codec).toMatch(/^avc1\.42/);
    expect(init?.tracks?.audio?.codec).toBe('mp4a.40.2');
    expect(boxes(init?.tracks?.video?.initSegment as Uint8Array)).toEqual(['ftyp', 'moov']);
    expect(boxes(result.video?.data1 as Uint8Array)).toEqual(['moof']);
    expect(boxes(result.video?.data2 as Uint8Array)).toEqual(['mdat']);
    // Timing: video starts at the TS first PTS (1.421333 s, ffprobe) relative to the init PTS.
    expect(result.video?.startPTS).toBeCloseTo(0.021, 2);
    expect((result.video?.endPTS ?? 0) - (result.video?.startPTS ?? 0)).toBeCloseTo(8, 1);
    expect(result.audio?.data2?.byteLength).toBeGreaterThan(10_000);
  });

  it('demuxes the video-only TS (cameras)', () => {
    const observer: HlsEventEmitter = { emit: () => true };
    const demuxer = new TSDemuxer(observer, DEFAULT_DEMUX_CONFIG, typeSupported, logger);
    demuxer.resetInitSegment(undefined, '', 'avc1.42c01e', 8, null, meta);
    const r = demuxer.demux(media('ts/clip-video-only.ts'), 0, meta, false, true);
    expect(r.videoTrack.samples.length).toBeGreaterThan(150);
    expect(r.audioTrack.samples).toHaveLength(0);
  });
});
