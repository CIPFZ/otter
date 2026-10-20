// Decode pool bookkeeping (ADR-008 §3) with a fake Worker: admission at maxDecoders with a FIFO
// queue and a reason, least-loaded Workers up to `size`, frames of an older generation dropped
// after reset, flush settled by the Worker or by reset. The Worker side runs in e2e.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecodePool, type WorkerCodec } from '@otter-player/decoder-pool';
import type { DecodedFrame, DecoderConfig, I420Frame } from '@otter-player/media';

class FakeWorker {
  static all: FakeWorker[] = [];
  posted: { t: string; id: number; [k: string]: unknown }[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: { t: string; id: number }): void {
    this.posted.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(m: Record<string, unknown>): void {
    this.onmessage?.({ data: m } as MessageEvent);
  }
}

const codec: WorkerCodec = { kind: 'fake', source: '() => ({ create() {} })' };
const config = (frames: DecodedFrame[] = [], errors: string[] = []): DecoderConfig => ({
  codec: 'hvc1.1.6.L93.90',
  output: (f) => frames.push(f),
  error: (e) => errors.push(e.details),
});
const chunk = () => ({ type: 'key' as const, timestamp: 0, data: new ArrayBuffer(4) });

beforeEach(() => {
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:pool', revokeObjectURL: () => undefined }));
});
afterEach(() => vi.unstubAllGlobals());

describe('decode pool', () => {
  it('spreads decoders over at most `size` Workers, least loaded first, kind source sent once per Worker', () => {
    const pool = createDecodePool({ size: 2, maxDecoders: 16 });
    for (let i = 0; i < 4; i++) pool.open(codec, config());
    expect(FakeWorker.all).toHaveLength(2);
    expect(pool.stats().slots.map((s) => s.worker)).toEqual([0, 1, 0, 1]);
    const opens = FakeWorker.all.flatMap((w) => w.posted.filter((m) => m.t === 'open'));
    expect(opens.filter((m) => m['source'] !== '')).toHaveLength(2);
    pool.destroy();
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
  });

  it('queues decoders beyond maxDecoders with a reason and starts them in order as slots free', () => {
    const pool = createDecodePool({ size: 1, maxDecoders: 2 });
    const reasons: string[] = [];
    const started: string[] = [];
    const a = pool.open(codec, config());
    pool.open(codec, config());
    const c = pool.open(codec, config(), { label: 'c', queued: (r) => reasons.push(`c: ${r}`), started: () => started.push('c') });
    pool.open(codec, config(), { label: 'd', queued: (r) => reasons.push(`d: ${r}`), started: () => started.push('d') });
    expect(reasons).toEqual(['c: 2 decoders busy (pool limit); waiting, 1 in line', 'd: 2 decoders busy (pool limit); waiting, 2 in line']);
    expect(pool.stats()).toMatchObject({ active: 2, queued: 2 });
    // A queued decoder buffers its chunks (and counts them as queued work).
    c.decode(chunk());
    expect(c.decodeQueueSize).toBe(1);
    a.close();
    expect(started).toEqual(['c']);
    const w = FakeWorker.all[0] as FakeWorker;
    const cId = (w.posted.filter((m) => m.t === 'open').at(-1) as { id: number }).id;
    expect(w.posted.filter((m) => m.id === cId).map((m) => m.t)).toEqual(['open', 'decode']);
    expect(pool.stats()).toMatchObject({ active: 2, queued: 1 });
  });

  it('drops frames from before a reset and settles flushes', async () => {
    const pool = createDecodePool({ size: 1 });
    const frames: DecodedFrame[] = [];
    const d = pool.open(codec, config(frames));
    const w = FakeWorker.all[0] as FakeWorker;
    const id = (w.posted[0] as { id: number }).id;
    const frame = (gen: number, ts: number): void => w.reply({ t: 'f', id, gen, frame: { format: 'I420', width: 2, height: 2, data: new Uint8Array(6), timestamp: ts } });
    d.decode(chunk());
    d.decode(chunk());
    expect(d.decodeQueueSize).toBe(2);
    w.reply({ t: 'q', id, n: 1, busy: 3, ack: 1 });
    expect(d.decodeQueueSize).toBe(2);
    frame(0, 1);
    const flushed = d.flush();
    d.reset();
    await flushed;
    frame(0, 2);
    frame(1, 3);
    expect(frames.map((f) => (f as I420Frame).timestamp)).toEqual([1, 3]);
    expect(w.posted.map((m) => m.t)).toEqual(['open', 'decode', 'decode', 'flush', 'reset']);
    const f2 = d.flush();
    w.reply({ t: 'flushed', id, n: 2 });
    await f2;
    expect(pool.stats().slots[0]).toMatchObject({ frames: 2, busyMs: 3 });
  });

  it('turns Worker errors into one fatal decoder error', () => {
    const pool = createDecodePool({ size: 1 });
    const errors: string[] = [];
    pool.open(codec, config([], errors));
    const w = FakeWorker.all[0] as FakeWorker;
    const id = (w.posted[0] as { id: number }).id;
    w.reply({ t: 'error', id, details: 'decodeError', message: 'bad' });
    w.reply({ t: 'error', id, details: 'decodeError', message: 'again' });
    expect(errors).toEqual(['decodeError']);
  });
});
