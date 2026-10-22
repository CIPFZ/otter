// @vitest-environment happy-dom
// MSE sink and ManagedMediaSource streaming hints (SPEC §6.2, ADR-008 §8): engines stop fetching
// between endstreaming and startstreaming.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMseSink } from '../src/mse-sink.js';

class FakeMediaSource extends EventTarget {
  readyState = 'open';
}
class FakeManagedMediaSource extends FakeMediaSource {
  streaming = true;
}

describe('MSE sink streaming', () => {
  beforeEach(() => {
    // Object URLs of MediaSource objects: not something the test environment makes.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:sink');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  });

  it('MediaSource always wants data', async () => {
    const sink = createMseSink(FakeMediaSource as unknown as typeof MediaSource, { backBufferS: 30 });
    expect(sink.streaming).toBe(true);
    await sink.whenStreaming();
    sink.destroy();
  });

  it('ManagedMediaSource: endstreaming stops, startstreaming resumes', async () => {
    const sink = createMseSink(FakeManagedMediaSource as unknown as typeof MediaSource, { backBufferS: 30 });
    const ms = sink.mediaSource as unknown as FakeManagedMediaSource;
    expect(sink.streaming).toBe(true);
    ms.streaming = false;
    ms.dispatchEvent(new Event('endstreaming'));
    expect(sink.streaming).toBe(false);
    let resumed = false;
    const waiting = sink.whenStreaming().then(() => {
      resumed = true;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(resumed).toBe(false);
    ms.streaming = true;
    ms.dispatchEvent(new Event('startstreaming'));
    await waiting;
    expect(resumed).toBe(true);
    // Destroy releases anyone still waiting.
    ms.dispatchEvent(new Event('endstreaming'));
    const released = sink.whenStreaming();
    sink.destroy();
    await released;
  });
});

/** SourceBuffer stand-in: appends add [start, end) from the data's first two bytes; async updateend. */
class FakeSourceBuffer extends EventTarget {
  mode = 'segments';
  updating = false;
  ranges: [number, number][] = [];
  aborts = 0;
  #pending: ReturnType<typeof setTimeout> | undefined;
  get buffered() {
    const r = this.ranges;
    return { length: r.length, start: (i: number) => (r[i] as [number, number])[0], end: (i: number) => (r[i] as [number, number])[1] };
  }
  appendBuffer(data: Uint8Array) {
    this.updating = true;
    this.#pending = setTimeout(() => {
      this.updating = false;
      if (data.length >= 2) this.ranges = merge([...this.ranges, [data[0] as number, data[1] as number]]);
      this.dispatchEvent(new Event('updateend'));
    }, 5);
  }
  remove(start: number, end: number) {
    this.updating = true;
    setTimeout(() => {
      this.updating = false;
      this.ranges = this.ranges.flatMap(([a, b]): [number, number][] => (b <= start || a >= end ? [[a, b]] : [...(a < start ? [[a, start] as [number, number]] : []), ...(b > end ? [[end, b] as [number, number]] : [])]));
      this.dispatchEvent(new Event('updateend'));
    }, 5);
  }
  abort() {
    this.aborts++;
    if (!this.updating) return;
    clearTimeout(this.#pending);
    this.updating = false;
    // As the spec says: abort, then updateend, in later tasks.
    setTimeout(() => {
      this.dispatchEvent(new Event('abort'));
      this.dispatchEvent(new Event('updateend'));
    }, 0);
  }
  changeType() {}
}
const merge = (r: [number, number][]): [number, number][] => {
  const s = [...r].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const x of s) {
    const last = out.at(-1);
    if (last !== undefined && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([...x]);
  }
  return out;
};
class FakeMs extends EventTarget {
  readyState = 'open';
  buffers: FakeSourceBuffer[] = [];
  addSourceBuffer() {
    const b = new FakeSourceBuffer();
    this.buffers.push(b);
    return b;
  }
}
const media = (start: number, end: number): Uint8Array => new Uint8Array([start, end]);

describe('MSE sink segment ledger and abort (ADR-010 §4)', () => {
  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:sink');
    vi.spyOn(URL, 'revokeObjectURL').mockReturnValue(undefined);
  });

  it('records appended segments, replaces overlapping ones, drops evicted ones', async () => {
    const sink = createMseSink(FakeMs as unknown as typeof MediaSource, { backBufferS: 10 });
    await sink.init([{ type: 'video', mimeType: 'video/mp4', data: new Uint8Array(0) }]);
    await sink.append('video', media(0, 4), { id: 's0', start: 0, end: 4, level: 'hi' });
    await sink.append('video', media(4, 8), { id: 's1', start: 4, end: 8, level: 'hi' });
    await sink.append('video', media(8, 12), { id: 's2', start: 8, end: 12, level: 'hi' });
    expect(sink.segments('video').map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    // A lower rendition's segment over s1 replaces it in the ledger.
    await sink.append('video', media(4, 8), { id: 'l1', start: 4, end: 8, level: 'lo' });
    expect(sink.segments('video').map((s) => `${s.id}:${s.level}`)).toEqual(['s0:hi', 'l1:lo', 's2:hi']);
    // Evicted (back buffer): gone from the ledger too.
    await sink.evict(16);
    expect(sink.segments('video').map((s) => s.id)).toEqual(['l1', 's2']);
    // Appends without a segment are not recorded.
    await sink.append('video', media(12, 16));
    expect(sink.segments('video')).toHaveLength(2);
    sink.destroy();
  });

  it('abort: pending operations reject, the append in progress stops, later appends run', async () => {
    const sink = createMseSink(FakeMs as unknown as typeof MediaSource, { backBufferS: 10 });
    await sink.init([{ type: 'video', mimeType: 'video/mp4', data: new Uint8Array(0) }]);
    const sb = (sink.mediaSource as unknown as FakeMs).buffers[0] as FakeSourceBuffer;
    const running = sink.append('video', media(0, 4), { id: 'a', start: 0, end: 4 });
    const queued = sink.append('video', media(4, 8), { id: 'b', start: 4, end: 8 });
    sink.abort('video');
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(sb.aborts).toBe(1);
    // The aborted append's own updateend does not complete the next operation.
    await sink.append('video', media(8, 12), { id: 'c', start: 8, end: 12 });
    expect(sink.segments('video').map((s) => s.id)).toEqual(['c']);
    expect(sb.ranges).toEqual([[8, 12]]);
    sink.destroy();
  });
});
