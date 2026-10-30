// A live MPEG-TS stream through mediabunny's ReadableStreamSource (ADR-013 §7): fetch is stubbed
// with the e2e clip as a stream that never closes; tracks and packets come out as bytes arrive.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createError } from '@otter-player/core';
import type { EncodedChunk, PacketStream } from '@otter-player/media';
import { openLiveTs } from '../src/index.js';

const clip = new Uint8Array(readFileSync(new URL('../../../e2e/media/ts/clip.ts', import.meta.url)));

function endless(bytes: Uint8Array, chunk: number): Response {
  let o = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(c) {
        if (o >= bytes.byteLength) return new Promise(() => undefined);
        await new Promise((r) => setTimeout(r, 5));
        c.enqueue(bytes.slice(o, o + chunk));
        o += chunk;
        return undefined;
      },
    }),
  );
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

describe('live MPEG-TS for WebCodecs', () => {
  it('opens before the stream ends: live, both tracks configured, video from a keyframe at 0, seeks into the history', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(endless(clip, 32 * 1024)));
    const d = await openLiveTs('http://x/live.ts', { signal: new AbortController().signal, createError });
    expect(d.info.duration).toBe(Number.POSITIVE_INFINITY);
    expect(d.info.video?.setup.codec).toMatch(/^avc1\./);
    // The track's codec is the decoders' string too (routing asks the decoder with it).
    expect(d.info.video?.codec).toBe(d.info.video?.setup.codec);
    expect(d.info.audio?.setup.codec).toMatch(/^mp4a\./);
    const v = await take(d.packets('video'), 120);
    expect(v[0]).toMatchObject({ type: 'key', timestamp: 0 });
    const s = await take(await d.seek('video', 2), 1);
    expect(s[0]?.type).toBe('key');
    expect(s[0]?.timestamp).toBeLessThanOrEqual(2e6);
    const a = await take(d.packets('audio'), 5);
    expect(a.length).toBe(5);
    d.destroy();
  });

  it('a failed request is a network error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 404 })));
    await expect(openLiveTs('http://x/missing.ts', { signal: new AbortController().signal, createError })).rejects.toMatchObject({ type: 'network', details: 'tsRequestFailed' });
  });
});
