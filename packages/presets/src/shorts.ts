// Preset `shorts` (SPEC §19「沉浸竖屏信息流」): a portrait player over a feed of short videos, built on
// `basic` (mp4-range + HLS on MSE / native, five controls). Each video loops; next / previous by
// API and by the ↑ / ↓ (Page Up / Down) keys. Muted by default (a feed autoplays). The swipe
// gestures come with batch 4 (ADR-013). Skin: ui-skin-minimal (portrait 9:16 for
// [data-otter-shorts]).

import type { LoadOptions, Source } from '@otter-player/media';
import { createBasicPlayer, type BasicOptions, type BasicPlayer } from './basic.js';

export interface ShortsOptions extends BasicOptions {
  readonly feed: readonly (string | Source)[];
  /** First video (index in `feed`). Default 0. */
  readonly start?: number;
}

export interface ShortsPlayer extends BasicPlayer {
  /** Index of the video in the feed now. */
  readonly index: number;
  /** Plays feed[i] from its start (clamped to the feed). */
  go(i: number, options?: LoadOptions): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
}

const NEXT = new Set(['ArrowDown', 'PageDown']);
const PREV = new Set(['ArrowUp', 'PageUp']);

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
      const cleanup = options.setup?.(parts);
      return () => {
        offEnded();
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
