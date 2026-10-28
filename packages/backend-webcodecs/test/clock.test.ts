// Shared AudioContext lifecycle and the master clock's time sources (ADR-008 §2), with a fake
// AudioContext: suspended IDLE_SUSPEND_MS after the last player stops, resumed on the next play,
// performance.now() while it cannot run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireAudioContext, createClock, IDLE_SUSPEND_MS, playingOnSharedContext, releaseAudioContext, RESUME_GRACE_MS, setPlaying } from '../src/clock.js';

class FakeAudioContext extends EventTarget {
  static instances: FakeAudioContext[] = [];
  /** How resume() behaves: settle and run, reject, never settle, or run after `resumeDelayMs`. */
  static resumeMode: 'ok' | 'reject' | 'hang' | 'slow' = 'ok';
  static resumeDelayMs = 0;
  state: AudioContextState = 'running';
  currentTime = 0;
  suspend = vi.fn(() => {
    this.set('suspended');
    return Promise.resolve();
  });
  resume = vi.fn(() => {
    if (FakeAudioContext.resumeMode === 'reject') return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
    if (FakeAudioContext.resumeMode === 'hang') return new Promise<void>(() => undefined);
    if (FakeAudioContext.resumeMode === 'slow') {
      return new Promise<void>((r) =>
        setTimeout(() => {
          this.set('running');
          r();
        }, FakeAudioContext.resumeDelayMs),
      );
    }
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
  FakeAudioContext.resumeDelayMs = 0;
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
    // A rejection is final at once; a pending resume only after the grace.
    if (mode === 'reject') expect(clock.unavailable).toBe('AudioContext resume() failed: NotAllowedError');
    else {
      expect(clock.unavailable).toBeUndefined();
      await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS);
      expect(clock.unavailable).toBe('AudioContext resume() not done after 3 s');
    }
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('a slow resume that succeeds within the grace takes the clock back seamlessly, nothing to report', async () => {
    FakeAudioContext.resumeMode = 'slow';
    FakeAudioContext.resumeDelayMs = 2500;
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    ctx.set('suspended');
    const clock = createClock(ctx as unknown as AudioContext);
    const sources: string[] = [];
    clock.onSource((s) => sources.push(s));
    clock.set(10);
    clock.start();
    await vi.advanceTimersByTimeAsync(2000);
    // Still within the grace: on the stand-in, keeping time, not reported.
    expect(clock.source).toBe('performance');
    expect(clock.unavailable).toBeUndefined();
    expect(clock.now()).toBeCloseTo(12, 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(clock.source).toBe('audio');
    expect(sources).toEqual(['audio']);
    // Seamless: media time carries on from the stand-in, then follows the context.
    expect(clock.now()).toBeCloseTo(12.5, 1);
    ctx.currentTime += 1;
    expect(clock.now()).toBeCloseTo(13.5, 1);
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS);
    expect(clock.unavailable).toBeUndefined();
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('a resume that lands after the grace still takes the clock back and withdraws the report', async () => {
    FakeAudioContext.resumeMode = 'slow';
    FakeAudioContext.resumeDelayMs = 4000;
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    ctx.set('suspended');
    const clock = createClock(ctx as unknown as AudioContext);
    clock.start();
    await vi.advanceTimersByTimeAsync(RESUME_GRACE_MS + 10);
    expect(clock.unavailable).toBe('AudioContext resume() not done after 3 s');
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock.source).toBe('audio');
    expect(clock.unavailable).toBeUndefined();
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('a resume is not read as frozen time: the watchdog does not count the suspension (WebKit)', async () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    clock.start();
    ctx.currentTime = 7.2;
    clock.check();
    clock.stop();
    // Idle: suspended for 6 s, its time standing still.
    ctx.set('suspended');
    vi.advanceTimersByTime(6000);
    // The resume lands; a render tick checks before the context's time has moved.
    clock.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(clock.source).toBe('audio');
    clock.check();
    expect(clock.source).toBe('audio');
    expect(clock.unavailable).toBeUndefined();
    vi.advanceTimersByTime(50);
    ctx.currentTime = 7.25;
    clock.check();
    expect(clock.source).toBe('audio');
    // A context that then really stops advancing is still caught, once the 2 s after the resume
    // are over (RESUME_SETTLE_S) and it stays frozen 0.5 s more.
    vi.advanceTimersByTime(600);
    clock.check();
    expect(clock.source).toBe('audio');
    vi.advanceTimersByTime(1500);
    clock.check();
    vi.advanceTimersByTime(600);
    clock.check();
    expect(clock.unavailable).toMatch(/^AudioContext time frozen for 0\.5 s \(at [\d.]+ s, still for [\d.]+ s\)$/);
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('right after a resume the context time may stand still for a while (output device opening): not frozen within 2 s', async () => {
    // Real Edge (M6 test round F2): after the idle suspend, resume() landed and the context said
    // running, but its time moved 0.06 s in the next 1.1 s.
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    clock.start();
    ctx.currentTime = 6.1;
    clock.check();
    clock.stop();
    ctx.set('suspended');
    vi.advanceTimersByTime(6000);
    clock.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let t = 0; t < 1150; t += 50) {
      vi.advanceTimersByTime(50);
      clock.check();
    }
    expect(clock.source).toBe('audio');
    expect(clock.unavailable).toBeUndefined();
    // Then it moves: still the context clock.
    ctx.currentTime = 6.16;
    vi.advanceTimersByTime(50);
    clock.check();
    expect(clock.source).toBe('audio');
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('a running context whose time stands still is left for performance.now()', () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    clock.start();
    // Past the first start's settling (RESUME_SETTLE_S), then frozen 0.5 s more.
    vi.advanceTimersByTime(2000);
    clock.check();
    vi.advanceTimersByTime(600);
    clock.check();
    expect(clock.source).toBe('performance');
    expect(clock.unavailable).toMatch(/^AudioContext time frozen for 0\.5 s \(at [\d.]+ s, still for [\d.]+ s\)$/);
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('the first start of a running context may stand still for a while too: not frozen within 2 s (M6 F9)', () => {
    // Real Edge, multiview: a context the page's first play started had its time frozen > 0.5 s.
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    clock.start();
    for (let t = 0; t < 1150; t += 50) {
      vi.advanceTimersByTime(50);
      clock.check();
    }
    expect(clock.source).toBe('audio');
    expect(clock.unavailable).toBeUndefined();
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('paused, a context whose time stands still is not counted as frozen (M6 F8)', () => {
    // Around the idle suspend the context's time may stop while it still says running.
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    clock.start();
    vi.advanceTimersByTime(3000);
    ctx.currentTime = 3;
    clock.check();
    clock.stop();
    for (let t = 0; t < 1000; t += 50) {
      vi.advanceTimersByTime(50);
      clock.check();
    }
    expect(clock.source).toBe('audio');
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('a context that froze and then runs again after a suspension takes the clock back (M6 F8)', async () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    clock.start();
    vi.advanceTimersByTime(3000);
    ctx.currentTime = 3;
    clock.check();
    // Frozen while playing: left for performance.now().
    vi.advanceTimersByTime(600);
    clock.check();
    expect(clock.unavailable).toMatch(/^AudioContext time frozen for 0\.5 s \(at [\d.]+ s, still for [\d.]+ s\)$/);
    clock.stop();
    ctx.set('suspended');
    vi.advanceTimersByTime(6000);
    // The next play resumes it: a fresh start, the context clock again, nothing to report.
    clock.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.state).toBe('running');
    expect(clock.source).toBe('audio');
    expect(clock.unavailable).toBeUndefined();
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });
});
