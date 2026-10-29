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
   * Called when the clock went back to a frozen context: its time moved steadily for RECOVER_S, or
   * (`via`: 'state change') it went through another state (suspended / interrupted) to running.
   * `stallS`: how long its time stood still (wall clock).
   */
  onRecover(h: (stallS: number, via?: 'state change') => void): void;
  /**
   * The context arrives later (created at the page's first user gesture): from now on time follows
   * it, re-anchored seamlessly. Until then the clock ran on performance.now() by design and
   * reported nothing (`deferred`).
   */
  attach(ctx: AudioContext): void;
  /**
   * Tries resume() again on a context still suspended (a later user gesture: WebKit makes the
   * gesture's context suspended and may not count the first event), within a fresh grace.
   */
  resume(): void;
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
/** A frozen context whose time then moves steadily this long (s) takes the clock back (M6 F9). */
export const RECOVER_S = 2;
/** The third stall within this window (s) leaves the clock on performance.now() until the next suspend / resume. */
export const STALL_WINDOW_S = 60;
const STALL_LIMIT = 3;
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
  /**
   * Recovery from a freeze (M6 F9: a virtual sound device stood still about 2 s now and then):
   * when the frozen time stopped moving, its last value and when it last moved, since when it has
   * moved steadily, the recent stalls, and whether the clock is pinned to performance.now().
   */
  let stallFrom = 0;
  let watchCtx = -1;
  let lastMove = 0;
  let movingSince = -1;
  const stalls: number[] = [];
  let pinned = false;
  /**
   * The context moves again after a freeze, the clock still on performance.now() for RECOVER_S:
   * the worklet plays meanwhile, anchored at the media time of that moment (M6: sound came back
   * 2 s after the device). Sound and time source are separate decisions: sound needs only a
   * context that runs now; the clock needs one that has run steadily.
   */
  let audibleOnStandIn = false;
  let recoverListener: ((stallS: number, via?: 'state change') => void) | undefined;
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
  /** When the context's time last moved (performance.now(), s): where a stall's length counts from. */
  let lastMoved = 0;
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
    anchorListener({ media: m, context: ctx.currentTime, rate, playing: playing && (source === 'audio' || audibleOnStandIn) });
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
  /**
   * Inside a user gesture this lets a suspended context run (autoplay policy). performance.now()
   * keeps time until it does; the statechange takes the clock back seamlessly whenever the resume
   * lands. Only a rejection, or no result within the grace (a context with no output device can
   * leave it pending, headless Firefox), makes the stand-in final. Another call (a later gesture)
   * tries again with a fresh grace; only the latest attempt counts.
   */
  let grace: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  const resumeWithGrace = (): void => {
    if (ctx === undefined || ctx.state !== 'suspended') return;
    const n = ++attempt;
    resuming = true;
    failure = undefined;
    clearTimeout(grace);
    grace = setTimeout(() => {
      if (!resuming || n !== attempt) return;
      resuming = false;
      failure = `AudioContext resume() not done after ${RESUME_GRACE_MS / 1000} s`;
    }, RESUME_GRACE_MS);
    ctx.resume().then(
      () => {
        if (n !== attempt) return;
        clearTimeout(grace);
        resuming = false;
        onState();
      },
      (err: unknown) => {
        if (n !== attempt) return;
        clearTimeout(grace);
        resuming = false;
        failure = `AudioContext resume() failed: ${(err as { name?: string } | null)?.name ?? String(err)}`;
      },
    );
  };
  const onState = (): void => {
    // Running again after a suspension: a new start of the device, the old freeze no longer says
    // anything about it (M6 F8).
    const state = ctx?.state;
    // Also a recovery from a freeze (the device stood still, then the context went through another
    // state): said like the other way back (watchRecovery).
    const fromStall = stuck && state === 'running' && lastState !== undefined && lastState !== 'running' ? performance.now() / 1000 - stallFrom : undefined;
    if (state === 'running' && lastState !== undefined && lastState !== 'running') {
      stuck = false;
      pinned = false;
      audibleOnStandIn = false;
    }
    lastState = state;
    if (usable()) failure = undefined;
    switchTo(usable() ? 'audio' : 'performance', `AudioContext ${ctx?.state ?? 'missing'}`);
    if (fromStall !== undefined && source === 'audio') recoverListener?.(fromStall, 'state change');
  };
  ctx?.addEventListener('statechange', onState);

  /** On performance.now() after a freeze: back to the context once its time has moved steadily for RECOVER_S. */
  const watchRecovery = (): void => {
    const c = (ctx as AudioContext).currentTime;
    const p = performance.now() / 1000;
    if (c !== watchCtx) {
      watchCtx = c;
      lastMove = p;
      if (movingSince < 0) {
        movingSince = p;
        // Sound at once, from where the media is now (the stall's samples are skipped).
        audibleOnStandIn = true;
        anchor();
      }
    } else if (p - lastMove > 0.1) {
      movingSince = -1;
      if (audibleOnStandIn) {
        audibleOnStandIn = false;
        anchor();
      }
    }
    if (movingSince < 0 || p - movingSince < RECOVER_S) return;
    const stallS = movingSince - stallFrom;
    stuck = false;
    failure = undefined;
    movingSince = -1;
    audibleOnStandIn = false;
    switchTo('audio', `AudioContext time moving again after a ${stallS.toFixed(2)} s stall`);
    recoverListener?.(stallS);
  };

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
      if (!resuming) resumeWithGrace();
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
      if (ctx === undefined) return;
      if (source === 'performance') {
        if (stuck && !pinned && playing && ctx.state === 'running') watchRecovery();
        return;
      }
      // Only while playing: paused, the context's time may stop on its way to the idle suspend
      // while it still says running (M6 F8); the baseline starts again on the next start().
      if (!playing) {
        rebaseWatchdog();
        return;
      }
      const c = ctx.currentTime;
      const p = performance.now() / 1000;
      if (c !== lastCtx) lastMoved = p;
      if (c !== lastCtx || p < settleUntil) {
        lastCtx = c;
        lastPerf = p;
        return;
      }
      if (p - lastPerf > STUCK_S) {
        stuck = true;
        audibleOnStandIn = false;
        // From the last movement, also when the stall began inside the settling window.
        stallFrom = Math.min(lastPerf, lastMoved > 0 ? lastMoved : lastPerf);
        watchCtx = c;
        movingSince = -1;
        stalls.push(p);
        while (stalls.length > 0 && p - (stalls[0] as number) > STALL_WINDOW_S) stalls.shift();
        pinned = stalls.length >= STALL_LIMIT;
        // With its numbers: where the context's time stood and for how long on the wall clock.
        failure =
          `AudioContext time frozen for ${STUCK_S} s (at ${c.toFixed(3)} s, still for ${(p - lastPerf).toFixed(2)} s)` +
          (pinned ? `; stall ${stalls.length} within ${STALL_WINDOW_S} s: performance.now() until the next suspend / resume` : '');
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
    onRecover(h) {
      recoverListener = h;
    },
    attach(next) {
      if (ctx !== undefined) return;
      ctx = next;
      deferred = false;
      ctx.addEventListener('statechange', onState);
      onState();
      // Playing: the context should run now (attach comes from inside the gesture), with the same
      // grace as start() (M6 F13: WebKit makes it suspended and resumes it a little later).
      if (playing) resumeWithGrace();
    },
    resume() {
      if (playing) resumeWithGrace();
    },
    destroy() {
      clearTimeout(grace);
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
