// Master clock of the WebCodecs backend (SPEC §6.3, ADR-008 §2): media time follows
// AudioContext.currentTime, with or without an audio track, so audio and every video stream of a
// page run on one timeline. While the context cannot run (autoplay policy before a gesture, no
// audio device), performance.now() stands in and the clock re-anchors when the context starts.

export interface ClockAnchor {
  /** Media time (s) at `context`. */
  readonly media: number;
  /** AudioContext time (s) the anchor was taken at. */
  readonly context: number;
  readonly rate: number;
  readonly playing: boolean;
}

export interface MediaClock {
  /** Where the time comes from right now. */
  readonly source: 'audio' | 'performance';
  /**
   * Why the AudioContext clock is not coming back, once that is settled: resume() rejected or
   * did not finish within RESUME_GRACE_MS, the context's time froze, or there is no context.
   * Undefined on the AudioContext clock, and while a resume is still within its grace (the
   * performance.now() stand-in keeps time meanwhile, nothing to report).
   */
  readonly unavailable: string | undefined;
  readonly playing: boolean;
  readonly rate: number;
  /** Media time in seconds. */
  now(): number;
  start(): void;
  /** Holds the current position. */
  stop(): void;
  set(time: number): void;
  setRate(rate: number): void;
  /** Called every render tick: detects a context that says running but does not advance. */
  check(): void;
  /** Anchor in AudioContext time, for the audio worklet; re-sent on every change. */
  onAnchor(h: (a: ClockAnchor) => void): void;
  /** Called when the time source changes (reason for QoE). */
  onSource(h: (source: 'audio' | 'performance', reason: string) => void): void;
  /**
   * The context arrives later (created at the page's first user gesture): from now on time follows
   * it, re-anchored seamlessly. Until then the clock ran on performance.now() by design and
   * reported nothing (`deferred`).
   */
  attach(ctx: AudioContext): void;
  destroy(): void;
}

export interface ClockOptions {
  /**
   * No context yet on purpose (no user gesture: the autoplay policy would hold one suspended):
   * performance.now() keeps time and `unavailable` stays undefined until attach().
   */
  readonly deferred?: boolean;
}

/** A running context whose currentTime is frozen this long (s) is treated as broken. */
const STUCK_S = 0.5;
/**
 * A resume() still pending after this is reported (an unwaitable device). A slow one that
 * succeeds later still takes the clock back.
 */
export const RESUME_GRACE_MS = 3000;
/**
 * After the context (re)starts its time may stand still a while (an output device opening: real
 * Edge, about 1.1 s once in 8, after a resume and at the first start): the frozen-time watchdog
 * only counts from this long (s) after it.
 */
export const RESUME_SETTLE_S = 2;

export function createClock(initial: AudioContext | undefined, options: ClockOptions = {}): MediaClock {
  let ctx = initial;
  let deferred = options.deferred === true && initial === undefined;
  let stuck = false;
  /** The context's state at the last statechange: a fresh 'running' after another one clears `stuck`. */
  let lastState = initial?.state;
  const usable = (): boolean => ctx !== undefined && ctx.state === 'running' && !stuck;
  let source: 'audio' | 'performance' = usable() ? 'audio' : 'performance';
  const host = (): number => (source === 'audio' ? (ctx as AudioContext).currentTime : performance.now() / 1000);
  let media = 0;
  let base = host();
  let rate = 1;
  let playing = false;
  let anchorListener: ((a: ClockAnchor) => void) | undefined;
  let sourceListener: ((s: 'audio' | 'performance', reason: string) => void) | undefined;
  // Watchdog for a running context that does not advance.
  let lastCtx = -1;
  let lastPerf = 0;
  /** performance.now() (s) until which the context is settling after a (re)start. */
  let settleUntil = 0;
  /** The first start() on a context already running is a (re)start too: it settles (M6 F9). */
  let firstStart = true;
  /** The pending resume (within its grace), and why the context clock is out once settled. */
  let resuming = false;
  let failure: string | undefined;

  const now = (): number => (playing ? media + (host() - base) * rate : media);
  const anchor = (): void => {
    if (ctx === undefined || anchorListener === undefined) return;
    // The worklet works in context time: re-express the anchor there.
    const m = now();
    anchorListener({ media: m, context: ctx.currentTime, rate, playing: playing && source === 'audio' });
  };
  const rebase = (): void => {
    media = now();
    base = host();
  };
  /**
   * The watchdog's baseline is only valid while the context runs: after a suspension (idle, or
   * the autoplay policy) its time stood still on purpose, and a tick landing before it moves again
   * would read the whole suspension as frozen time (seen on WebKit, ADR-008 §2).
   */
  const rebaseWatchdog = (): void => {
    lastCtx = -1;
  };
  const switchTo = (next: 'audio' | 'performance', reason: string): void => {
    if (next === source) return;
    if (next === 'audio') {
      rebaseWatchdog();
      settleUntil = performance.now() / 1000 + RESUME_SETTLE_S;
    }
    media = now();
    source = next;
    base = host();
    sourceListener?.(next, reason);
    anchor();
  };
  const onState = (): void => {
    // Running again after a suspension: a new start of the device, the old freeze no longer says
    // anything about it (M6 F8).
    const state = ctx?.state;
    if (state === 'running' && lastState !== undefined && lastState !== 'running') stuck = false;
    lastState = state;
    if (usable()) failure = undefined;
    switchTo(usable() ? 'audio' : 'performance', `AudioContext ${ctx?.state ?? 'missing'}`);
  };
  ctx?.addEventListener('statechange', onState);

  return {
    get source() {
      return source;
    },
    get unavailable() {
      if (source === 'audio' || resuming || deferred) return undefined;
      return failure ?? (ctx === undefined ? 'no AudioContext' : `AudioContext ${ctx.state}`);
    },
    get playing() {
      return playing;
    },
    get rate() {
      return rate;
    },
    now,
    start() {
      if (playing) return;
      base = host();
      playing = true;
      rebaseWatchdog();
      if (firstStart && source === 'audio') settleUntil = performance.now() / 1000 + RESUME_SETTLE_S;
      firstStart = false;
      // Inside a user gesture this lets a suspended context run (autoplay policy). performance.now()
      // keeps time until it does; the statechange takes the clock back seamlessly whenever the
      // resume lands. Only a rejection, or no result within the grace (a context with no output
      // device can leave it pending, headless Firefox), makes the stand-in final.
      if (ctx !== undefined && ctx.state === 'suspended' && !resuming) {
        const c = ctx;
        resuming = true;
        failure = undefined;
        const grace = setTimeout(() => {
          if (!resuming) return;
          resuming = false;
          failure = `AudioContext resume() not done after ${RESUME_GRACE_MS / 1000} s`;
        }, RESUME_GRACE_MS);
        c.resume().then(
          () => {
            clearTimeout(grace);
            resuming = false;
            onState();
          },
          (err: unknown) => {
            clearTimeout(grace);
            resuming = false;
            failure = `AudioContext resume() failed: ${(err as { name?: string } | null)?.name ?? String(err)}`;
          },
        );
      }
      anchor();
    },
    stop() {
      if (!playing) return;
      media = now();
      playing = false;
      anchor();
    },
    set(time) {
      media = time;
      base = host();
      anchor();
    },
    setRate(r) {
      rebase();
      rate = r;
      anchor();
    },
    check() {
      if (source !== 'audio' || ctx === undefined) return;
      // Only while playing: paused, the context's time may stop on its way to the idle suspend
      // while it still says running (M6 F8); the baseline starts again on the next start().
      if (!playing) {
        rebaseWatchdog();
        return;
      }
      const c = ctx.currentTime;
      const p = performance.now() / 1000;
      if (c !== lastCtx || p < settleUntil) {
        lastCtx = c;
        lastPerf = p;
        return;
      }
      if (p - lastPerf > STUCK_S) {
        stuck = true;
        failure = `AudioContext time frozen for ${STUCK_S} s`;
        switchTo('performance', failure);
      }
    },
    onAnchor(h) {
      anchorListener = h;
      anchor();
    },
    onSource(h) {
      sourceListener = h;
    },
    attach(next) {
      if (ctx !== undefined) return;
      ctx = next;
      deferred = false;
      ctx.addEventListener('statechange', onState);
      onState();
      // Playing: the context should run now (attach comes from inside the gesture).
      if (playing && ctx.state === 'suspended') void ctx.resume().then(onState, () => undefined);
    },
    destroy() {
      ctx?.removeEventListener('statechange', onState);
      anchorListener = undefined;
      sourceListener = undefined;
    },
  };
}

// One AudioContext per page, shared by every WebCodecs instance (one timeline, one output);
// closed when the last instance lets go. While no instance plays it is suspended after
// IDLE_SUSPEND_MS (no audio thread running for a paused page); the next play resumes it (clock
// start), and a resume that fails or hangs leaves that clock on performance.now(), reported as
// audioClockUnavailable by the backend.
export const IDLE_SUSPEND_MS = 5000;

let shared: { ctx: AudioContext; users: number; playing: Set<object>; idle: ReturnType<typeof setTimeout> | undefined } | undefined;

export function acquireAudioContext(): AudioContext | undefined {
  if (shared === undefined) {
    if (typeof AudioContext !== 'function') return undefined;
    try {
      shared = { ctx: new AudioContext({ latencyHint: 'playback' }), users: 0, playing: new Set(), idle: undefined };
    } catch {
      return undefined;
    }
  }
  shared.users++;
  return shared.ctx;
}

/** Instances currently playing on the shared context. */
export const playingOnSharedContext = (): number => shared?.playing.size ?? 0;

/**
 * Marks `owner` as playing or not on `ctx`. The context is suspended IDLE_SUSPEND_MS after the
 * last player stops, unless one starts again before.
 */
export function setPlaying(ctx: AudioContext | undefined, owner: object, playing: boolean): void {
  const s = shared;
  if (ctx === undefined || s?.ctx !== ctx) return;
  if (playing) {
    s.playing.add(owner);
    if (s.idle !== undefined) clearTimeout(s.idle);
    s.idle = undefined;
    return;
  }
  if (!s.playing.delete(owner) || s.playing.size > 0 || s.idle !== undefined) return;
  s.idle = setTimeout(() => {
    s.idle = undefined;
    if (shared === s && s.playing.size === 0 && s.ctx.state === 'running') void s.ctx.suspend().catch(() => undefined);
  }, IDLE_SUSPEND_MS);
}

export function releaseAudioContext(ctx: AudioContext | undefined, owner?: object): void {
  if (ctx === undefined || shared?.ctx !== ctx) return;
  if (owner !== undefined) setPlaying(ctx, owner, false);
  if (--shared.users > 0) return;
  if (shared.idle !== undefined) clearTimeout(shared.idle);
  shared = undefined;
  void ctx.close().catch(() => undefined);
}
