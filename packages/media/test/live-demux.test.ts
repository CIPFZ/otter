import { describe, expect, it } from 'vitest';
import { createLiveFanout, type LivePacket } from '@otter-player/media';

const packet = (seconds: number, key = true): LivePacket => ({ key, timestamp: seconds * 1e6, duration: 100_000, data: new Uint8Array([seconds % 256]) });

describe('bounded live packet history', () => {
  it('slow subscribers share the retained window instead of retaining the entire broadcast', async () => {
    const fanout = createLiveFanout(2);
    const slow = fanout.packets('video', 0)[Symbol.asyncIterator]();
    const other = fanout.packets('video', 0)[Symbol.asyncIterator]();
    for (let t = 0; t <= 100; t++) fanout.push('video', packet(t, t % 2 === 0));
    fanout.end();
    const got: number[] = [];
    for (;;) {
      const next = await slow.next();
      if (next.done) break;
      got.push(next.value.timestamp / 1e6);
    }
    expect(got).toEqual([98, 99, 100]);
    expect((await other.next()).value?.timestamp).toBe(98e6);
    await other.return?.();
  });

  it('an expired video cursor waits for a keyframe and never resumes at a delta', async () => {
    const fanout = createLiveFanout(2);
    fanout.push('video', packet(0));
    const reader = fanout.packets('video', 0)[Symbol.asyncIterator]();
    await reader.next();
    fanout.push('video', packet(1, false));
    fanout.push('video', packet(3, false));
    fanout.push('video', packet(4, false));
    expect(fanout.startTime('video')).toBe(Infinity);
    let delivered = false;
    const pending = reader.next().then((v) => { delivered = true; return v; });
    fanout.push('video', packet(5, false));
    await Promise.resolve();
    expect(delivered).toBe(false);
    fanout.push('video', packet(6));
    expect((await pending).value).toMatchObject({ type: 'key', timestamp: 6e6 });
    expect(fanout.startTime('video')).toBe(6);
    await reader.return?.();
  });

  it('audio and video retain their own original timestamps and audio-only windows advance', async () => {
    const fanout = createLiveFanout(2);
    fanout.push('video', packet(10));
    fanout.push('audio', packet(10.003));
    fanout.push('audio', packet(13.003));
    expect(fanout.startTime('video')).toBe(10);
    expect(fanout.startTime('audio')).toBe(13.003);
    const reader = fanout.packets('audio', 10)[Symbol.asyncIterator]();
    expect((await reader.next()).value?.timestamp).toBe(13.003e6);
    await reader.return?.();
  });

  it('return wakes a reader waiting for a future packet', async () => {
    const reader = createLiveFanout().packets('video', 0)[Symbol.asyncIterator]();
    const pending = reader.next();
    await reader.return?.();
    expect(await pending).toEqual({ done: true, value: undefined });
  });
});

describe('live history resource budgets', () => {
  const retained = async (fanout: ReturnType<typeof createLiveFanout>, track: 'video' | 'audio') => {
    fanout.end();
    const packets = [];
    for await (const p of fanout.packets(track, -Infinity)) packets.push(p);
    return packets;
  };

  it.each(['video', 'audio'] as const)('caps %s packets independently of repeated or decreasing timestamps', async (track) => {
    for (const repeated of [true, false]) {
      const fanout = createLiveFanout(15, { maxPackets: 4, maxBytes: 100 });
      for (let i = 20; i > 0; i--) fanout.push(track, packet(repeated ? 0 : i));
      const got = await retained(fanout, track);
      expect(got).toHaveLength(4);
      expect(got.map((p) => p.timestamp / 1e6)).toEqual(repeated ? [0, 0, 0, 0] : [4, 3, 2, 1]);
    }
  });

  it('enforces the default 8192-packet cap even for zero-byte samples at one timestamp', async () => {
    const fanout = createLiveFanout();
    for (let i = 0; i < 8193; i++) fanout.push('audio', { ...packet(0), data: new Uint8Array(0) });
    expect(await retained(fanout, 'audio')).toHaveLength(8192);
  });

  it.each(['video', 'audio'] as const)('caps %s bytes independently of the packet count and timestamp window', async (track) => {
    const fanout = createLiveFanout(15, { maxBytes: 5, maxPackets: 100 });
    for (let i = 0; i < 20; i++) fanout.push(track, { ...packet(0), data: new Uint8Array([i, i]) });
    const got = await retained(fanout, track);
    expect(got.map((p) => [...new Uint8Array(p.data)])).toEqual([[18, 18], [19, 19]]);
    expect(got.reduce((n, p) => n + p.data.byteLength, 0)).toBeLessThanOrEqual(5);
  });

  it('resource eviction during a long GOP waits for another keyframe instead of returning retained deltas', async () => {
    const fanout = createLiveFanout(15, { maxPackets: 4 });
    fanout.push('video', packet(0));
    const reader = fanout.packets('video', 0)[Symbol.asyncIterator]();
    await reader.next();
    for (let i = 0; i < 40; i++) fanout.push('video', packet(0, false));
    expect(fanout.startTime('video')).toBe(Infinity);
    let delivered = false;
    const pending = reader.next().then((v) => { delivered = true; return v; });
    fanout.push('video', packet(0, false));
    await Promise.resolve();
    expect(delivered).toBe(false);
    fanout.push('video', packet(1));
    expect((await pending).value).toMatchObject({ type: 'key', timestamp: 1e6 });
    await reader.return?.();
  });

  it.each(['oversized', 'NaN', 'Infinity'] as const)('%s packets break video continuity and are never retained', async (invalid) => {
    const fanout = createLiveFanout(15, { maxBytes: 8 });
    fanout.push('video', packet(0));
    const reader = fanout.packets('video', 0)[Symbol.asyncIterator]();
    await reader.next();
    for (let i = 0; i < 20; i++) fanout.push('video', { ...packet(0, false), timestamp: invalid === 'oversized' ? 0 : Number(invalid), data: new Uint8Array(invalid === 'oversized' ? 9 : 1) });
    expect(fanout.startTime('video')).toBe(Infinity);
    fanout.push('video', packet(1, false));
    let delivered = false;
    const pending = reader.next().then((v) => { delivered = true; return v; });
    await Promise.resolve();
    expect(delivered).toBe(false);
    fanout.push('video', packet(2));
    expect((await pending).value).toMatchObject({ type: 'key', timestamp: 2e6 });
    await reader.return?.();
  });

  it('owns only the packet bytes rather than pinning a larger input buffer through its view', async () => {
    const fanout = createLiveFanout(15, { maxBytes: 8 });
    const backing = new Uint8Array(1024);
    backing[500] = 7;
    fanout.push('audio', { ...packet(0), data: backing.subarray(500, 501) });
    backing[500] = 9;
    const got = await retained(fanout, 'audio');
    expect([...new Uint8Array(got[0]!.data)]).toEqual([7]);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects an invalid resource limit %s', (limit) => {
    expect(() => createLiveFanout(15, { maxBytes: limit })).toThrow(RangeError);
    expect(() => createLiveFanout(15, { maxPackets: limit })).toThrow(RangeError);
  });
});
