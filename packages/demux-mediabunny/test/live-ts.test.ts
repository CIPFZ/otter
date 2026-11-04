// A live MPEG-TS stream through mediabunny's ReadableStreamSource (ADR-013 §7): fetch is stubbed
// with the e2e clip as a stream that never closes; tracks and packets come out as bytes arrive.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createError } from '@otter-player/core';
import type { EncodedChunk, PacketStream } from '@otter-player/media';
import { openLiveTs } from '../src/index.js';
import { shiftTimestamps } from './ts-writer.js';

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

  // M6 F16: mediabunny reads a PES only once the next PES of its PID starts, and hands a packet out
  // only once it has the next one (for its duration). Live, the last AAC frame of each PES then
  // waits for the PES after next (~0.34 s on the e2e stream): CI underruns, each at a PES's last
  // frame. The adapter reads AAC itself; a PES's frames are out as soon as its bytes are in.
  it('AAC: every frame of an audio PES is out once that PES has arrived, before the next audio PES starts', async () => {
    // clip.ts (ffprobe): audio PES at 1.400, 1.763, 2.104, 2.445, 2.787 s; the fifth one (2.787 s)
    // starts at byte 97760; the first video keyframe (media time 0) is at 1.421333 s.
    const cut = clip.slice(0, 97760);
    vi.stubGlobal('fetch', () => Promise.resolve(endless(cut, 8 * 1024)));
    const d = await openLiveTs('http://x/live.ts', { signal: new AbortController().signal, createError });
    const got: EncodedChunk[] = [];
    const it = d.packets('audio')[Symbol.asyncIterator]();
    for (;;) {
      const next = await Promise.race([it.next(), new Promise<'idle'>((r) => setTimeout(() => r('idle'), 1500))]);
      if (next === 'idle' || next.done === true) break;
      got.push(next.value);
    }
    const end = Math.max(...got.map((c) => c.timestamp + (c.duration ?? 0)));
    // The fourth PES (2.445..2.787 s) is complete in the bytes delivered: audio to 2.787 - 1.421 s.
    expect(end).toBeGreaterThanOrEqual(Math.round((2.786667 - 1.421333) * 1e6) - 2);
    d.destroy();
  });

  it('AAC frames as mediabunny reads them from the whole file: same bytes (ADTS frames), same times', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(endless(clip, 32 * 1024)));
    const d = await openLiveTs('http://x/live.ts', { signal: new AbortController().signal, createError });
    const live = await take(d.packets('audio'), 40);
    d.destroy();
    const { Input, BufferSource, MPEG_TS, EncodedPacketSink } = await import('mediabunny');
    const input = new Input({ source: new BufferSource(clip), formats: [MPEG_TS] });
    const base = (await new EncodedPacketSink((await input.getPrimaryVideoTrack())!).getFirstPacket())!.timestamp;
    const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
    const whole: { timestamp: number; data: Uint8Array }[] = [];
    for (let p = await sink.getFirstPacket(); p !== null && whole.length < 60; p = await sink.getNextPacket(p)) {
      const timestamp = Math.round((p.timestamp - base) * 1e6);
      if (timestamp >= 0) whole.push({ timestamp, data: p.data });
    }
    expect(live.map((c) => c.timestamp)).toEqual(whole.slice(0, 40).map((c) => c.timestamp));
    expect(live.map((c) => Buffer.from(new Uint8Array(c.data)).toString('hex'))).toEqual(whole.slice(0, 40).map((c) => Buffer.from(c.data).toString('hex')));
  });

  /** Live audio timestamps vs mediabunny reading the whole file (its timeline, minus the first keyframe). */
  async function compareWithMediabunny(bytes: Uint8Array, n: number): Promise<{ live: number[]; whole: number[] }> {
    vi.stubGlobal('fetch', () => Promise.resolve(endless(bytes, 32 * 1024)));
    const d = await openLiveTs('http://x/live.ts', { signal: new AbortController().signal, createError });
    const live = (await take(d.packets('audio'), n)).map((c) => c.timestamp);
    d.destroy();
    const { Input, BufferSource, MPEG_TS, EncodedPacketSink } = await import('mediabunny');
    const input = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
    const base = (await new EncodedPacketSink((await input.getPrimaryVideoTrack())!).getFirstPacket())!.timestamp;
    const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
    const whole: number[] = [];
    for (let p = await sink.getFirstPacket(); p !== null && whole.length < n; p = await sink.getNextPacket(p)) {
      const t = Math.round((p.timestamp - base) * 1e6);
      if (t >= 0) whole.push(t);
    }
    return { live, whole };
  }

  it('PTS across the 33-bit wrap: the audio stays on the video’s (mediabunny’s) timeline', async () => {
    // Every PTS / DTS moved so that the first one (video, 1.421333 s) is 1 s before 2^33: the
    // stream wraps one second in.
    const shifted = shiftTimestamps(clip, 2 ** 33 - 90_000 - Math.round(1.421333 * 90_000));
    const { live, whole } = await compareWithMediabunny(shifted, 150);
    expect(live).toHaveLength(150);
    expect(live.map((t) => Math.round(t / 100))).toEqual(whole.map((t) => Math.round(t / 100)));
    // Across the wrap (about 1 s in): continuous.
    for (let i = 1; i < live.length; i++) expect((live[i] as number) - (live[i - 1] as number)).toBeCloseTo(21_333, -2);
  });

  for (const [file, type, codec] of [
    ['audio-mp3.ts', '0x03', 'mp3'],
    ['audio-ac3.ts', '0x81', 'ac-3'],
  ] as const) {
    it(`${codec} audio (stream type ${type}): mediabunny's path, said once as a non-fatal tsAudioFallback; the audio still plays`, async () => {
      const bytes = new Uint8Array(readFileSync(new URL(`../../../e2e/media/ts/${file}`, import.meta.url)));
      vi.stubGlobal('fetch', () => Promise.resolve(endless(bytes, 32 * 1024)));
      const notices: { details: string; fatal: boolean; message?: string }[] = [];
      const d = await openLiveTs('http://x/live.ts', { signal: new AbortController().signal, createError, notice: (e) => notices.push(e as never) });
      expect(d.info.audio?.codec).toBe(codec);
      const a = await take(d.packets('audio'), 10);
      expect(a).toHaveLength(10);
      expect(notices).toEqual([expect.objectContaining({ details: 'tsAudioFallback', fatal: false })]);
      expect(notices[0]?.message).toContain(type);
      d.destroy();
    });
  }

  it('AAC in LATM (stream type 0x11), which mediabunny does not read: a tsAudioFallback saying there is no sound; video plays', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('../../../e2e/media/ts/audio-latm.ts', import.meta.url)));
    vi.stubGlobal('fetch', () => Promise.resolve(endless(bytes, 32 * 1024)));
    const notices: { details: string; message?: string }[] = [];
    const d = await openLiveTs('http://x/live.ts', { signal: new AbortController().signal, createError, notice: (e) => notices.push(e as never) });
    expect(d.info.audio).toBeNull();
    expect((await take(d.packets('video'), 5))[0]).toMatchObject({ type: 'key', timestamp: 0 });
    expect(notices).toEqual([expect.objectContaining({ details: 'tsAudioFallback', message: expect.stringContaining('0x11') as unknown })]);
    expect(notices[0]?.message).toContain('no sound');
    d.destroy();
  });

  it('a failed request is a network error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 404 })));
    await expect(openLiveTs('http://x/missing.ts', { signal: new AbortController().signal, createError })).rejects.toMatchObject({ type: 'network', details: 'tsRequestFailed' });
  });
});
