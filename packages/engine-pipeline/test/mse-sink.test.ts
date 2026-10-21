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
