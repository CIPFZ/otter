// HTTP-FLV as a WebCodecs Demuxer (ADR-013 §7): fetch is stubbed with the e2e clip, streamed in
// chunks; the demuxer is live (infinite duration), media time 0 is the first keyframe, and each
// seek is a subscriber from the right keyframe / audio frame with its own copies of the bytes.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createError } from '@otter-player/core';
import type { EncodedChunk, PacketStream } from '@otter-player/media';
import { openFlvDemuxer } from '../src/flv-demux.js';

const clip = new Uint8Array(readFileSync(new URL('../../../e2e/media/flv/clip.flv', import.meta.url)));

function streamOf(bytes: Uint8Array, chunk: number, endless = false): Response {
  let o = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (o >= bytes.byteLength) {
        if (!endless) c.close();
        return new Promise(() => undefined);
      }
      c.enqueue(bytes.slice(o, o + chunk));
      o += chunk;
      return undefined;
    },
  });
  return new Response(body, { status: 200 });
}

async function take(s: PacketStream, n: number): Promise<EncodedChunk[]> {
  const out: EncodedChunk[] = [];
  for await (const c of s) {
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('FLV demuxer for WebCodecs', () => {
  it('opens live with both tracks configured, video from a keyframe at 0', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(streamOf(clip, 16 * 1024)));
    const d = await openFlvDemuxer('http://x/live.flv', { signal: new AbortController().signal, createError });
    expect(d.info.duration).toBe(Number.POSITIVE_INFINITY);
    expect(d.info.video).toMatchObject({ width: 640, height: 360, codec: expect.stringMatching(/^avc1\./) as unknown });
    expect(d.info.video?.setup.description?.byteLength).toBeGreaterThan(10);
    expect(d.info.audio).toMatchObject({ sampleRate: 48000, channels: 2 });
    const v = await take(d.packets('video'), 30);
    expect(v[0]).toMatchObject({ type: 'key', timestamp: 0 });
    const a = await take(d.packets('audio'), 10);
    expect(a[0]?.timestamp).toBeGreaterThanOrEqual(0);
    expect(a[1]?.duration).toBeCloseTo((1024 / 48000) * 1e6, 0);
    d.destroy();
  });

  it('audio that arrives before the first keyframe but is timed at or after it plays from media time 0 (ADR-013 §7)', async () => {
    // clip.flv's first keyframe tag (21 ms) moved after the two audio tags timed 21 and 42 ms, as
    // an encoder that muxes audio ahead does; each tag (with its PreviousTagSize) moves whole.
    const blocks: Uint8Array[] = [];
    for (let o = 13; o + 11 <= clip.length; ) {
      const size = ((clip[o + 1] as number) << 16) | ((clip[o + 2] as number) << 8) | (clip[o + 3] as number);
      blocks.push(clip.subarray(o, o + 11 + size + 4));
      o += 11 + size + 4;
    }
    // Blocks: script, AVC config, AAC config, AAC 0, keyframe 21, AAC 21, AAC 42, ...
    const [script, avcc, aacc, a0, key, a21, a42, ...tail] = blocks as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, ...Uint8Array[]];
    const reordered = new Uint8Array(clip.length);
    let at = 0;
    for (const b of [clip.subarray(0, 13), script, avcc, aacc, a0, a21, a42, key, ...tail]) {
      reordered.set(b, at);
      at += b.length;
    }
    vi.stubGlobal('fetch', () => Promise.resolve(streamOf(reordered, 256)));
    const d = await openFlvDemuxer('http://x/live.flv', { signal: new AbortController().signal, createError });
    const a = await take(d.packets('audio'), 3);
    // The 21 ms frame is media time 0, the 42 ms one 21 ms; the 0 ms one is before 0 and dropped.
    expect(a.map((c) => c.timestamp)).toEqual([0, 21_000, 43_000]);
    d.destroy();
  });

  it('joined mid-GOP: video before the first keyframe is skipped; audio that arrives before the keyframe plays by its time (ADR-013 §7)', async () => {
    // clip.flv (GOP 1 s, keyframes at 21 and 1021 ms) from its first tag at or after 521 ms, as a
    // server without a GOP cache sends it to a client that joins there. The 1021 ms keyframe is
    // moved after the audio tags timed 1024 and 1045 ms, as a mux with the audio ahead.
    const tags: { block: Uint8Array; type: number; ts: number }[] = [];
    for (let o = 13; o + 11 <= clip.length; ) {
      const size = ((clip[o + 1] as number) << 16) | ((clip[o + 2] as number) << 8) | (clip[o + 3] as number);
      const ts = (((clip[o + 4] as number) << 16) | ((clip[o + 5] as number) << 8) | (clip[o + 6] as number)) + ((clip[o + 7] as number) << 24);
      tags.push({ block: clip.subarray(o, o + 11 + size + 4), type: clip[o] as number, ts });
      o += 11 + size + 4;
    }
    // Script, AVC config, AAC config: sent first, as the fixture's server does.
    const head = tags.slice(0, 3);
    const tail = tags.slice(3).filter((t) => t.ts >= 521);
    const key = tail.findIndex((t) => t.type === 9 && t.ts === 1021);
    const ahead = tail.filter((t) => t.type === 8 && (t.ts === 1024 || t.ts === 1045));
    expect(key).toBeGreaterThan(0);
    expect(ahead).toHaveLength(2);
    const order = [...tail.slice(0, key).filter((t) => !ahead.includes(t)), ...ahead, ...tail.slice(key).filter((t) => !ahead.includes(t))];
    const bytes = new Uint8Array(clip.length);
    let at = 0;
    for (const b of [clip.subarray(0, 13), ...head.map((t) => t.block), ...order.map((t) => t.block)]) {
      bytes.set(b, at);
      at += b.length;
    }
    vi.stubGlobal('fetch', () => Promise.resolve(streamOf(bytes.subarray(0, at), 256)));
    const d = await openFlvDemuxer('http://x/live.flv', { signal: new AbortController().signal, createError });
    const v = await take(d.packets('video'), 2);
    expect(v.map((c) => [c.type, c.timestamp])).toEqual([
      ['key', 0],
      ['delta', 40_000],
    ]);
    // The 1024 ms frame is 3 ms after media time 0; every audio tag before 1021 ms is dropped.
    const a = await take(d.packets('audio'), 3);
    expect(a.map((c) => c.timestamp)).toEqual([3000, 24_000, 45_000]);
    d.destroy();
  });

  it('a seek starts at the last keyframe at or before the time; each subscriber gets its own bytes', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(streamOf(clip, 64 * 1024, true)));
    const d = await openFlvDemuxer('http://x/live.flv', { signal: new AbortController().signal, createError });
    // Let the whole clip arrive (history), then seek into it.
    await take(d.packets('video'), 200);
    const s = await take(await d.seek('video', 3), 2);
    expect(s[0]?.type).toBe('key');
    expect(s[0]?.timestamp).toBeLessThanOrEqual(3e6);
    const again = await take(await d.seek('video', 3), 1);
    expect(again[0]?.timestamp).toBe(s[0]?.timestamp);
    expect(again[0]?.data).not.toBe(s[0]?.data);
    const audio = await take(await d.seek('audio', 3), 1);
    expect(audio[0]?.timestamp).toBeLessThanOrEqual(3e6);
    expect((audio[0]?.timestamp ?? 0) + (audio[0]?.duration ?? 0)).toBeGreaterThan(3e6);
    d.destroy();
  });

  it('a stream that is not FLV, or a failed request, rejects with a network error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(streamOf(new TextEncoder().encode('<html>not a stream</html>'), 1024)));
    await expect(openFlvDemuxer('http://x/a.flv', { signal: new AbortController().signal, createError })).rejects.toMatchObject({ type: 'network', details: 'flvBadHeader' });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 404 })));
    await expect(openFlvDemuxer('http://x/b.flv', { signal: new AbortController().signal, createError })).rejects.toMatchObject({ type: 'network', details: 'flvRequestFailed' });
  });
});
