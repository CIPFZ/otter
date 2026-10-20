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
  destroy(): void;
}

/** A running context whose currentTime is frozen this long (s) is treated as broken. */
const STUCK_S = 0.5;
/** resume() that has not settled by then is left behind (an unwaitable device). */
const RESUME_TIMEOUT_MS = 1000;

export function createClock(ctx: AudioContext | undefined): MediaClock {
  let stuck = false;
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
  const switchTo = (next: 'audio' | 'performance', reason: string): void => {
    if (next === source) return;
    media = now();
    source = next;
    base = host();
    sourceListener?.(next, reason);
    anchor();
  };
  const onState = (): void => switchTo(usable() ? 'audio' : 'performance', `AudioContext ${ctx?.state ?? 'missing'}`);
  ctx?.addEventListener('statechange', onState);

  return {
    get source() {
      return source;
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
      // Inside a user gesture this lets a suspended context run (autoplay policy). Bounded: a
      // context with no output device can leave resume() pending (headless Firefox), and the
      // clock must keep time either way (performance.now() until it starts).
      if (ctx !== undefined && ctx.state === 'suspended') {
        void Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, RESUME_TIMEOUT_MS))]).catch(() => undefined);
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
      const c = ctx.currentTime;
      const p = performance.now() / 1000;
      if (c !== lastCtx) {
        lastCtx = c;
        lastPerf = p;
        return;
      }
      if (p - lastPerf > STUCK_S) {
        stuck = true;
        switchTo('performance', `AudioContext time frozen for ${STUCK_S} s`);
      }
    },
    onAnchor(h) {
      anchorListener = h;
      anchor();
    },
    onSource(h) {
      sourceListener = h;
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
