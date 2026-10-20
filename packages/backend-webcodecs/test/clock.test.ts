// Shared AudioContext lifecycle and the master clock's time sources (ADR-008 §2), with a fake
// AudioContext: suspended IDLE_SUSPEND_MS after the last player stops, resumed on the next play,
// performance.now() while it cannot run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireAudioContext, createClock, IDLE_SUSPEND_MS, playingOnSharedContext, releaseAudioContext, setPlaying } from '../src/clock.js';

class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = [];
  /** How resume() behaves: settle and run, reject, or never settle. */
  static resumeMode: 'ok' | 'reject' | 'hang' = 'ok';
  state: AudioContextState = 'running';
  currentTime = 0;
  suspend = vi.fn(() => {
    this.set('suspended');
    return Promise.resolve();
  });
  resume = vi.fn(() => {
    if (FakeAudioContext.resumeMode === 'reject') return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
    if (FakeAudioContext.resumeMode === 'hang') return new Promise<void>(() => undefined);
    this.set('running');
    return Promise.resolve();
  });
  close = vi.fn(() => {
    this.set('closed');
    return Promise.resolve();
  });
  constructor() {
    super();
    FakeAudioContext.instances.push(this);
  }
  set(state: AudioContextState): void {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  FakeAudioContext.resumeMode = 'ok';
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('shared AudioContext lifecycle', () => {
  it('is shared, suspended 5 s after the last player stops, closed with the last user', async () => {
    const a = acquireAudioContext() as unknown as FakeAudioContext;
    const b = acquireAudioContext() as unknown as FakeAudioContext;
    expect(a).toBe(b);
    const one = {};
    const two = {};
    setPlaying(a as unknown as AudioContext, one, true);
    setPlaying(a as unknown as AudioContext, two, true);
    expect(playingOnSharedContext()).toBe(2);
    setPlaying(a as unknown as AudioContext, one, false);
    vi.advanceTimersByTime(IDLE_SUSPEND_MS * 2);
    // One instance still plays: no suspend.
    expect(a.suspend).not.toHaveBeenCalled();
    setPlaying(a as unknown as AudioContext, two, false);
    vi.advanceTimersByTime(IDLE_SUSPEND_MS - 1);
    expect(a.suspend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(a.suspend).toHaveBeenCalledTimes(1);
    expect(a.state).toBe('suspended');
    releaseAudioContext(a as unknown as AudioContext, one);
    expect(a.close).not.toHaveBeenCalled();
    releaseAudioContext(a as unknown as AudioContext, two);
    expect(a.close).toHaveBeenCalledTimes(1);
  });

  it('a play within the 5 s keeps it running', () => {
    const ctx = acquireAudioContext() as AudioContext;
    const p = {};
    setPlaying(ctx, p, true);
    setPlaying(ctx, p, false);
    vi.advanceTimersByTime(IDLE_SUSPEND_MS - 100);
    setPlaying(ctx, p, true);
    vi.advanceTimersByTime(IDLE_SUSPEND_MS * 3);
    expect((ctx as unknown as FakeAudioContext).suspend).not.toHaveBeenCalled();
    releaseAudioContext(ctx, p);
  });

  it('the next play resumes a suspended context and the clock goes back to it', async () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    const sources: string[] = [];
    clock.onSource((s) => sources.push(s));
    expect(clock.source).toBe('audio');
    ctx.set('suspended');
    expect(clock.source).toBe('performance');
    clock.start();
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(clock.source).toBe('audio');
    expect(sources).toEqual(['performance', 'audio']);
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it.each(['reject', 'hang'] as const)('a resume that fails (%s) leaves the clock on performance.now(), still keeping time', async (mode) => {
    FakeAudioContext.resumeMode = mode;
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    ctx.set('suspended');
    const clock = createClock(ctx as unknown as AudioContext);
    clock.set(3);
    clock.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(clock.source).toBe('performance');
    expect(clock.now()).toBeGreaterThan(4.4);
    expect(clock.now()).toBeLessThan(4.6);
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('a running context whose time stands still is left for performance.now()', () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    clock.start();
    clock.check();
    vi.advanceTimersByTime(600);
    clock.check();
    expect(clock.source).toBe('performance');
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });
});
