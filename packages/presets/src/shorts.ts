// Preset `shorts` (SPEC §19 row "immersive portrait feed"): a vertical feed of short videos, built on
// `basic` (mp4-range + HLS on MSE / native, five controls). Each video loops; next / previous by
// API, by the ↑ / ↓ (Page Up / Down) keys and by vertical swipes on the picture (ADR-013 batch 4):
// up for the next, down for the previous, past a distance or fast enough (a short quick flick
// counts); a tap pauses / plays, a double tap calls the host's `onLike`, a long press plays at a
// higher rate while held. One video element, one engine: switching tears the previous one down
// before the next loads (at most one decoding instance alive). Muted by default (a feed autoplays).
// Skin: ui-skin-minimal (vertical 9:16 for [data-otter-shorts]).

import type { LoadOptions, Source } from '@otter-player/media';
import { createBasicPlayer, type BasicOptions, type BasicPlayer } from './basic.js';

/** Tuning of the `shorts` gestures on the picture. */
export interface ShortsGestureOptions {
  /**
   * Swipe distance that switches, as a fraction of the player's height.
   * @defaultValue `0.2`
   */
  readonly distance?: number;
  /**
   * Release speed (px / ms over the last 100 ms) that switches below that distance, from
   * `flickMinPx` moved.
   * @defaultValue `0.5`
   */
  readonly flickSpeed?: number;
  /**
   * Least distance of a flick, px.
   * @defaultValue `30`
   */
  readonly flickMinPx?: number;
  /**
   * Playback rate while long-pressed.
   * @defaultValue `2`
   */
  readonly holdRate?: number;
  /**
   * Long press, ms.
   * @defaultValue `500`
   */
  readonly longPressMs?: number;
  /**
   * A second tap within this many ms is a double tap.
   * @defaultValue `250`
   */
  readonly doubleTapMs?: number;
}

/** Options of the `shorts` preset: the `basic` options, the feed and the gestures. */
export interface ShortsOptions extends BasicOptions {
  /** The videos, in order; the preset loads `feed[start]` itself. */
  readonly feed: readonly (string | Source)[];
  /**
   * First video (index in `feed`).
   * @defaultValue `0`
   */
  readonly start?: number;
  /**
   * Double tap on the picture: the host's like (index in the feed, where in the player, 0..1).
   * @defaultValue none (a double tap does nothing)
   */
  readonly onLike?: (index: number, at: { readonly x: number; readonly y: number }) => void;
  /**
   * Swipe / tap / long-press tuning; `false`: no gestures (keys and API only).
   * @defaultValue `{}` (the defaults above)
   */
  readonly gestures?: ShortsGestureOptions | false;
  /**
   * Start muted: a feed autoplays, and browsers allow that only without sound.
   * @defaultValue `true`
   */
  readonly muted?: boolean;
}

/** A `shorts` player: a `basic` player that moves through its feed. */
export interface ShortsPlayer extends BasicPlayer {
  /** Index of the video in the feed now. */
  readonly index: number;
  /** Plays feed[i] from its start (clamped to the feed). */
  go(i: number, options?: LoadOptions): Promise<void>;
  /** Plays the next video (nothing past the end). */
  next(): Promise<void>;
  /** Plays the previous video (nothing before the first). */
  prev(): Promise<void>;
}

const NEXT = new Set(['ArrowDown', 'PageDown']);
const PREV = new Set(['ArrowUp', 'PageUp']);

/**
 * A vertical feed of short videos: each loops; next / previous by swipe, ↑ / ↓ keys or API; tap
 * pauses, double tap calls `onLike`, long press speeds up. One `<video>`, one engine, nothing
 * preloaded. Muted by default (a feed autoplays).
 * @example
 * ```ts
 * import { createShortsPlayer } from '@otter-player/presets/shorts';
 * import '@otter-player/ui-skin-minimal';
 *
 * // Loads feed[0] itself; swipe up / down for the next / previous one.
 * const player = createShortsPlayer({ container, feed: sources, onLike: (index) => console.log('liked', index) });
 * ```
 */
export function createShortsPlayer(options: ShortsOptions): ShortsPlayer {
  const { feed } = options;
  let index = Math.min(Math.max(options.start ?? 0, 0), Math.max(0, feed.length - 1));
  let go: (i: number, o?: LoadOptions) => Promise<void> = () => Promise.resolve();
  const player = createBasicPlayer({
    ...options,
    muted: options.muted ?? true,
    setup(parts) {
      parts.root.setAttribute('data-otter-shorts', '');
      // Each video loops: at its end, from the start again.
      let ended = false;
      const offEnded = parts.store.subscribe((s) => {
        if (s.ended && !ended) {
          parts.store.dispatch('seek', { time: 0 });
          parts.store.dispatch('play', undefined);
        }
        ended = s.ended;
      });
      const onKey = (e: KeyboardEvent): void => {
        if (NEXT.has(e.key)) void step(1);
        else if (PREV.has(e.key)) void step(-1);
        else return;
        e.preventDefault();
      };
      parts.root.addEventListener('keydown', onKey);
      const offGestures = options.gestures === false ? () => undefined : bindShortsGestures(parts.root, parts.video, parts.store, options.gestures ?? {}, {
        step: (d) => step(d),
        canStep: (d) => index + d >= 0 && index + d < feed.length,
        like: (at) => options.onLike?.(index, at),
      });
      const cleanup = options.setup?.(parts);
      return () => {
        offEnded();
        offGestures();
        parts.root.removeEventListener('keydown', onKey);
        parts.root.removeAttribute('data-otter-shorts');
        cleanup?.();
      };
    },
  });
  go = (i, o) => {
    if (feed.length === 0) return Promise.resolve();
    index = Math.min(Math.max(i, 0), feed.length - 1);
    return player.load(feed[index] as string | Source, o ?? { autoplay: true });
  };
  /** One video on or back; nothing past either end of the feed. */
  function step(d: number): Promise<void> {
    const i = index + d;
    return i < 0 || i >= feed.length ? Promise.resolve() : go(i);
  }
  const shorts: ShortsPlayer = {
    ...player,
    get index() {
      return index;
    },
    go: (i, o) => go(i, o),
    next: () => step(1),
    prev: () => step(-1),
  };
  if (feed.length > 0) void go(index);
  return shorts;
}

/** Elements whose pointer input is theirs, not the picture's. */
const INTERACTIVE = '[data-otter-controls], button, input, a, [role="slider"], [role="button"]';

interface Feed {
  step(d: number): Promise<void>;
  canStep(d: number): boolean;
  like(at: { readonly x: number; readonly y: number }): void;
}

/**
 * Pointer gestures on the picture (touch, pen, mouse alike). Vertical drags move the video with the
 * finger; on release it switches when the distance passed `distance` x height, or the last 100 ms
 * were faster than `flickSpeed` over at least `flickMinPx`; otherwise it snaps back. Taps toggle
 * play / pause after `doubleTapMs` unless a second tap makes it a like; a long press holds the rate.
 */
function bindShortsGestures(root: HTMLElement, video: HTMLVideoElement, store: { getState(): { paused: boolean }; dispatch(type: 'toggle-paused' | 'hold-rate', payload: unknown): boolean }, o: ShortsGestureOptions, feed: Feed): () => void {
  const distance = o.distance ?? 0.2;
  const flickSpeed = o.flickSpeed ?? 0.5;
  const flickMin = o.flickMinPx ?? 30;
  const holdRate = o.holdRate ?? 2;
  const longMs = o.longPressMs ?? 500;
  const doubleMs = o.doubleTapMs ?? 250;
  const SLOP = 10;
  type Press = { id: number; x0: number; y0: number; t0: number; mode: 'press' | 'drag' | 'long' | 'scroll-x'; samples: { t: number; y: number }[]; long: ReturnType<typeof setTimeout> };
  let press: Press | undefined;
  let tap: { at: number; timer: ReturnType<typeof setTimeout> } | undefined;
  /** A switch animating out: further swipes wait for it. */
  let switching = false;

  const move = (px: number, ms: number): void => {
    video.style.transition = ms > 0 ? `transform ${ms}ms cubic-bezier(0.2, 0, 0, 1)` : 'none';
    video.style.transform = px === 0 ? '' : `translateY(${px}px)`;
  };
  const height = (): number => root.getBoundingClientRect().height || 1;

  const onDown = (e: PointerEvent): void => {
    if (!e.isPrimary || press !== undefined || switching) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.composedPath().some((n) => n instanceof Element && n !== root && root.contains(n) && n.matches(INTERACTIVE))) return;
    const p: Press = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      t0: e.timeStamp,
      mode: 'press',
      samples: [{ t: e.timeStamp, y: e.clientY }],
      long: setTimeout(() => {
        if (press !== p || p.mode !== 'press') return;
        p.mode = 'long';
        store.dispatch('hold-rate', { rate: holdRate });
      }, longMs),
    };
    press = p;
  };

  const onMove = (e: PointerEvent): void => {
    const p = press;
    if (p === undefined || e.pointerId !== p.id) return;
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    if (p.mode === 'press' && Math.hypot(dx, dy) > SLOP) {
      clearTimeout(p.long);
      p.mode = Math.abs(dy) >= Math.abs(dx) ? 'drag' : 'scroll-x';
    }
    if (p.mode !== 'drag') return;
    e.preventDefault();
    p.samples.push({ t: e.timeStamp, y: e.clientY });
    while (p.samples.length > 2 && e.timeStamp - (p.samples[0] as { t: number }).t > 100) p.samples.shift();
    // Past either end of the feed the picture follows at a third: it is not going anywhere.
    const d = dy < 0 ? 1 : -1;
    move(feed.canStep(d) ? dy : dy / 3, 0);
  };

  const onUp = (e: PointerEvent): void => {
    const p = press;
    if (p === undefined || e.pointerId !== p.id) return;
    press = undefined;
    clearTimeout(p.long);
    if (p.mode === 'long') {
      store.dispatch('hold-rate', { rate: 0 });
      return;
    }
    if (p.mode === 'drag') {
      const dy = e.clientY - p.y0;
      p.samples.push({ t: e.timeStamp, y: e.clientY });
      const first = p.samples[0] as { t: number; y: number };
      const dt = Math.max(1, e.timeStamp - first.t);
      const speed = Math.abs(e.clientY - first.y) / dt;
      const d = dy < 0 ? 1 : -1;
      const far = Math.abs(dy) >= distance * height();
      const flick = speed >= flickSpeed && Math.abs(dy) >= flickMin;
      if (e.type === 'pointerup' && (far || flick) && feed.canStep(d)) {
        // Out the way it was going, then the next one loads (the old engine goes first) and the
        // picture comes back to its place.
        switching = true;
        move(-d * height(), 180);
        setTimeout(() => {
          move(0, 0);
          switching = false;
          void feed.step(d);
        }, 180);
      } else {
        move(0, 200);
      }
      return;
    }
    if (p.mode !== 'press' || e.type !== 'pointerup') return;
    const r = root.getBoundingClientRect();
    const at = { x: r.width > 0 ? (e.clientX - r.left) / r.width : 0.5, y: r.height > 0 ? (e.clientY - r.top) / r.height : 0.5 };
    if (tap !== undefined && e.timeStamp - tap.at < doubleMs) {
      clearTimeout(tap.timer);
      tap = undefined;
      feed.like(at);
      return;
    }
    const t = {
      at: e.timeStamp,
      timer: setTimeout(() => {
        if (tap === t) tap = undefined;
        store.dispatch('toggle-paused', undefined);
      }, doubleMs),
    };
    tap = t;
  };

  const touchAction = root.style.touchAction;
  // Vertical drags are the feed's, not the page's scrolling.
  root.style.touchAction = 'none';
  root.addEventListener('pointerdown', onDown);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onUp);
  return () => {
    root.style.touchAction = touchAction;
    root.removeEventListener('pointerdown', onDown);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('pointercancel', onUp);
    if (press !== undefined) clearTimeout(press.long);
    if (tap !== undefined) clearTimeout(tap.timer);
    move(0, 0);
  };
}
