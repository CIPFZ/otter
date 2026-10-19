// The FLV demuxer port works on the e2e test media (ffprobe: 10 s, 640x360 H.264 Constrained
// Baseline 25 fps, AAC-LC 48 kHz stereo).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLVDemuxer } from '../src/index.ts';
import type { FlvAudioSample, FlvTrack, FlvTrackMeta, FlvVideoSample } from '../src/demux/flv-demuxer.ts';
import buffersAreEqual from '../src/utils/typedarray-equality.ts';

const flv = (): ArrayBuffer => {
  const b = readFileSync(new URL('../../../e2e/media/flv/clip.flv', import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

function demux(chunks: ArrayBuffer[]) {
  const probe = FLVDemuxer.probe(chunks[0] as ArrayBuffer);
  const demuxer = new FLVDemuxer(probe, {});
  const meta: Record<string, FlvTrackMeta> = {};
  const errors: string[] = [];
  let video = 0;
  let audio = 0;
  let firstVideo: FlvVideoSample | undefined;
  demuxer.onError = (type, info) => void errors.push(`${type}: ${info}`);
  demuxer.onMediaInfo = () => undefined;
  demuxer.onTrackMetadata = (type, m) => void (meta[type] = m);
  demuxer.onDataAvailable = (a: FlvTrack<FlvAudioSample>, v: FlvTrack<FlvVideoSample>) => {
    firstVideo ??= v.samples[0];
    video += v.samples.length;
    audio += a.samples.length;
    v.samples = [];
    a.samples = [];
  };
  let byteStart = 0;
  let pending = new Uint8Array(0);
  for (const c of chunks) {
    // Like a loader: unconsumed bytes are prepended to the next chunk.
    const merged = new Uint8Array(pending.byteLength + c.byteLength);
    merged.set(pending);
    merged.set(new Uint8Array(c), pending.byteLength);
    const consumed = demuxer.parseChunks(merged.buffer, byteStart);
    byteStart += consumed;
    pending = merged.subarray(consumed);
  }
  return { probe, meta, errors, video, audio, firstVideo };
}

describe('mpegts.js L2 copy: FLV demuxer', () => {
  it('probes the header and demuxes H.264 + AAC with track metadata', () => {
    const r = demux([flv()]);
    expect(r.probe).toMatchObject({ match: true, hasAudioTrack: true, hasVideoTrack: true });
    expect(r.errors).toEqual([]);
    expect(r.meta['video']).toMatchObject({ codec: expect.stringMatching(/^avc1\.42/), codecWidth: 640, codecHeight: 360 });
    // The source is AAC-LC; outside Firefox / Android mpegts.js signals HE-AAC (mp4a.40.5) on purpose.
    expect(r.meta['audio']).toMatchObject({ originalCodec: 'mp4a.40.2', audioSampleRate: 48000, channelCount: 2 });
    expect(r.meta['audio']?.codec).toMatch(/^mp4a\.40\.[25]$/);
    expect(r.video).toBe(250); // 10 s at 25 fps
    expect(r.audio).toBe(470); // ffprobe: 470 AAC frames
    expect(r.firstVideo?.isKeyframe).toBe(true);
  });

  it('gives the same result when the stream arrives in small chunks (live loader)', () => {
    const whole = flv();
    const chunks: ArrayBuffer[] = [];
    for (let o = 0; o < whole.byteLength; o += 4096) chunks.push(whole.slice(o, o + 4096));
    const r = demux(chunks);
    expect(r.errors).toEqual([]);
    expect(r.video).toBe(250);
  });

  it('Otter fix: AAC configs of different lengths are not equal (upstream compared number[])', () => {
    expect(buffersAreEqual(Uint8Array.from([0x11, 0x90]), Uint8Array.from([0x11, 0x90, 0x56, 0xe5]))).toBe(false);
  });
});
