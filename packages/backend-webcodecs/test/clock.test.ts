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

  it('a context attached at the first gesture gets the resume grace too (WebKit: made suspended, resume() lands later) (M6 F13)', async () => {
    FakeAudioContext.resumeMode = 'slow';
    FakeAudioContext.resumeDelayMs = 400;
    const clock = createClock(undefined, { deferred: true });
    clock.start();
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    ctx.state = 'suspended';
    clock.attach(ctx as unknown as AudioContext);
    // Resuming: the stand-in keeps time, nothing to report.
    expect(clock.unavailable).toBeUndefined();
    await vi.advanceTimersByTimeAsync(450);
    expect(ctx.state).toBe('running');
    expect(clock.source).toBe('audio');
    expect(clock.unavailable).toBeUndefined();
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('resume() retries a context still suspended after the first gesture (a later click resumes it)', async () => {
    FakeAudioContext.resumeMode = 'hang';
    const clock = createClock(undefined, { deferred: true });
    clock.start();
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    ctx.state = 'suspended';
    clock.attach(ctx as unknown as AudioContext);
    await vi.advanceTimersByTimeAsync(2000);
    expect(clock.unavailable).toBeUndefined();
    // The next gesture: this time resume() works, within a fresh grace.
    FakeAudioContext.resumeMode = 'ok';
    clock.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(clock.source).toBe('audio');
    await vi.advanceTimersByTimeAsync(3000);
    expect(clock.unavailable).toBeUndefined();
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  /** Plays `ms` of wall time in 50 ms ticks, the context's time moving with it or not. */
  const run = (clock: ReturnType<typeof createClock>, ctx: FakeAudioContext, ms: number, moving: boolean): void => {
    for (let t = 0; t < ms; t += 50) {
      vi.advanceTimersByTime(50);
      if (moving) ctx.currentTime += 0.05;
      clock.check();
    }
  };

  it('a context frozen for a while and then moving steadily for 2 s takes the clock back, with the stall length (M6 F9)', () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    const recovered: number[] = [];
    clock.onRecover((s) => recovered.push(s));
    clock.start();
    run(clock, ctx, 2500, true);
    // Frozen 2 s (a virtual sound device): left for performance.now() after 0.5 s.
    run(clock, ctx, 2000, false);
    expect(clock.source).toBe('performance');
    expect(clock.unavailable).toMatch(/^AudioContext time frozen/);
    // Moving again: still the stand-in for the first 2 s, then back, nothing left to report.
    run(clock, ctx, 1500, true);
    expect(clock.source).toBe('performance');
    run(clock, ctx, 700, true);
    expect(clock.source).toBe('audio');
    expect(clock.unavailable).toBeUndefined();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toBeGreaterThan(1.9);
    expect(recovered[0]).toBeLessThan(2.2);
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('a stall that began inside the first start\'s settling window counts from the last movement (M6 F9)', () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    const recovered: number[] = [];
    clock.onRecover((s) => recovered.push(s));
    clock.start();
    run(clock, ctx, 1000, true);
    // Stands still from 1 s to 3 s: the settling window (2 s) hides the first second of it.
    run(clock, ctx, 2000, false);
    run(clock, ctx, 2200, true);
    expect(clock.source).toBe('audio');
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toBeGreaterThan(1.9);
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('sound comes back as soon as the context moves again, aligned to the media time now; the clock still waits 2 s (M6)', () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    const anchors: { media: number; context: number; playing: boolean }[] = [];
    clock.onAnchor((a) => anchors.push(a));
    clock.start();
    run(clock, ctx, 2500, true);
    run(clock, ctx, 2000, false);
    expect(clock.source).toBe('performance');
    expect(anchors.at(-1)?.playing).toBe(false);
    // The context moves again: the first check with movement re-anchors the worklet, playing.
    vi.advanceTimersByTime(50);
    ctx.currentTime += 0.05;
    clock.check();
    const a = anchors.at(-1) as { media: number; context: number; playing: boolean };
    expect(a.playing).toBe(true);
    // Aligned to where the media is now (the stall's audio is skipped), in context time.
    expect(a.media).toBeCloseTo(clock.now(), 6);
    expect(a.context).toBe(ctx.currentTime);
    expect(clock.source).toBe('performance');
    // While the clock waits, worklet and clock agree: media at the context's time = clock.now().
    run(clock, ctx, 1000, true);
    expect(a.media + (ctx.currentTime - a.context)).toBeCloseTo(clock.now(), 3);
    run(clock, ctx, 1200, true);
    expect(clock.source).toBe('audio');
    expect(anchors.at(-1)?.playing).toBe(true);
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('if the context stops again during the wait, the worklet goes silent again', () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    const anchors: { playing: boolean }[] = [];
    clock.onAnchor((a) => anchors.push(a));
    clock.start();
    run(clock, ctx, 2500, true);
    run(clock, ctx, 2000, false);
    run(clock, ctx, 300, true);
    expect(anchors.at(-1)?.playing).toBe(true);
    run(clock, ctx, 300, false);
    expect(anchors.at(-1)?.playing).toBe(false);
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });

  it('the third stall within 60 s keeps performance.now() until the next suspend / resume (M6 F9)', async () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    clock.start();
    run(clock, ctx, 2500, true);
    for (let i = 0; i < 2; i++) {
      run(clock, ctx, 1000, false);
      run(clock, ctx, 4500, true);
      expect(clock.source).toBe('audio');
    }
    run(clock, ctx, 1000, false);
    expect(clock.unavailable).toMatch(/stall 3 within 60 s/);
    run(clock, ctx, 5000, true);
    expect(clock.source).toBe('performance');
    // Paused, idle-suspended, played again: a fresh start of the device.
    clock.stop();
    ctx.set('suspended');
    clock.start();
    await vi.advanceTimersByTimeAsync(0);
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

  it('a context that froze and then runs again after a suspension takes the clock back (M6 F8), and says so like any recovery', async () => {
    const ctx = acquireAudioContext() as unknown as FakeAudioContext;
    const clock = createClock(ctx as unknown as AudioContext);
    const recovered: number[] = [];
    const via: (string | undefined)[] = [];
    clock.onRecover((s, how) => {
      recovered.push(s);
      via.push(how);
    });
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
    // The recovery is said with the stall's length (from the last movement to running again).
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toBeGreaterThan(6);
    // Marked: this recovery came through a state change, not the 2 s of steady time.
    expect(via).toEqual(['state change']);
    clock.destroy();
    releaseAudioContext(ctx as unknown as AudioContext);
  });
});
