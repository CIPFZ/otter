// A live MPEG-TS stream through mediabunny's ReadableStreamSource (ADR-013 §7): fetch is stubbed
// with the e2e clip as a stream that never closes; tracks and packets come out as bytes arrive.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createError } from '@otter-player/core';
import type { EncodedChunk, PacketStream } from '@otter-player/media';
import { openLiveTs } from '../src/index.js';
import { join, shiftTimestamps } from './ts-writer.js';

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

  /**
   * `bytes` joined mid-GOP: from the first video PES at or after the middle of the first GOP (no
   * PAT / PMT first: they repeat every ~0.1 s in the e2e files), with the first `ahead` audio PES
   * that start after the next keyframe's PES moved before it, as a mux with the audio ahead.
   */
  function midGop(bytes: Uint8Array, ahead: number): Uint8Array {
    const n = bytes.length / 188;
    const at = (i: number) => {
      const o = i * 188;
      const pid = (((bytes[o + 1] as number) & 0x1f) << 8) | (bytes[o + 2] as number);
      const afc = ((bytes[o + 3] as number) >> 4) & 3;
      const s = o + 4 + ((afc & 2) !== 0 ? 1 + (bytes[o + 4] as number) : 0);
      const start = ((bytes[o + 1] as number) & 0x40) !== 0 && bytes[s] === 0 && bytes[s + 1] === 0 && bytes[s + 2] === 1;
      const p = bytes.subarray(s + 9);
      const pts = start && ((bytes[s + 7] as number) & 0x80) !== 0 ? (((p[0] as number) & 0x0e) * 2 ** 29 + (p[1] as number) * 2 ** 22 + ((p[2] as number) & 0xfe) * 2 ** 14 + (p[3] as number) * 2 ** 7 + ((p[4] as number) >> 1)) / 90_000 : undefined;
      // random_access_indicator: set on the video's keyframes (and on every audio PES) in these files.
      const rai = (afc & 2) !== 0 && (bytes[o + 4] as number) > 0 && ((bytes[o + 5] as number) & 0x40) !== 0;
      return { pid, start, pts, rai };
    };
    const all = Array.from({ length: n }, (_, i) => ({ i, ...at(i) }));
    const keys = all.filter((p) => p.pid === 0x100 && p.start && p.rai);
    const [k0, k1] = keys as [(typeof all)[number], (typeof all)[number]];
    const middle = ((k0.pts as number) + (k1.pts as number)) / 2;
    const from = all.find((p) => p.pid === 0x100 && p.start && (p.pts as number) >= middle) as (typeof all)[number];
    const audioStarts = all.filter((p) => p.pid === 0x101 && p.start && p.i > k1.i).slice(0, ahead + 1);
    const moved = all.filter((p) => p.pid === 0x101 && p.i >= (audioStarts[0] as (typeof all)[number]).i && p.i < (audioStarts[ahead] as (typeof all)[number]).i);
    const order = [...all.slice(from.i, k1.i), ...moved, ...all.slice(k1.i).filter((p) => !moved.includes(p))];
    return join(order.map((p) => bytes.subarray(p.i * 188, p.i * 188 + 188)));
  }

  for (const [file, codec] of [
    ['clip.ts', 'AAC (own reader)'],
    ['audio-mp3.ts', 'MP3 (mediabunny)'],
  ] as const) {
    it(`joined mid-GOP, ${codec}: video before the first keyframe is skipped; audio that arrives before the keyframe plays by its time (ADR-013 §7)`, async () => {
      // Audio ~0.7 s ahead (three PES of ~0.34 s): its frames at or after the keyframe have all
      // come out of the demuxer before the keyframe's bytes arrive.
      const bytes = midGop(new Uint8Array(readFileSync(new URL(`../../../e2e/media/ts/${file}`, import.meta.url))), 3);
      vi.stubGlobal('fetch', () => Promise.resolve(endless(bytes, 188 * 8)));
      const d = await openLiveTs('http://x/live.ts', { signal: new AbortController().signal, createError });
      const v = await take(d.packets('video'), 2);
      // Up to 20 frames, or what came before 1.5 s without one (the stream does not end).
      const live: number[] = [];
      const it = d.packets('audio')[Symbol.asyncIterator]();
      while (live.length < 20) {
        const next = await Promise.race([it.next(), new Promise<'idle'>((r) => setTimeout(() => r('idle'), 1500))]);
        if (next === 'idle' || next.done === true) break;
        live.push(next.value.timestamp);
      }
      d.destroy();
      expect(v.map((c) => [c.type, c.timestamp])).toEqual([
        ['key', 0],
        ['delta', 40_000],
      ]);
      // The same bytes read whole by mediabunny: audio at or after the first keyframe.
      const { Input, BufferSource, MPEG_TS, EncodedPacketSink } = await import('mediabunny');
      const input = new Input({ source: new BufferSource(bytes), formats: [MPEG_TS] });
      const video = new EncodedPacketSink((await input.getPrimaryVideoTrack())!);
      let key = await video.getFirstPacket();
      while (key !== null && key.type !== 'key') key = await video.getNextPacket(key);
      const base = (key as { timestamp: number }).timestamp;
      const sink = new EncodedPacketSink((await input.getPrimaryAudioTrack())!);
      const whole: number[] = [];
      for (let p = await sink.getFirstPacket(); p !== null && whole.length < 20; p = await sink.getNextPacket(p)) {
        const t = Math.round((p.timestamp - base) * 1e6);
        if (t >= 0) whole.push(t);
      }
      // The first frame is within one frame of media time 0 (AAC 21.3 ms, MP3 24 ms).
      expect(whole[0]).toBeLessThan(24_000);
      expect(live.map((t) => Math.round(t / 100))).toEqual(whole.map((t) => Math.round(t / 100)));
    });
  }

  it('a failed request is a network error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(null, { status: 404 })));
    await expect(openLiveTs('http://x/missing.ts', { signal: new AbortController().signal, createError })).rejects.toMatchObject({ type: 'network', details: 'tsRequestFailed' });
  });
});
