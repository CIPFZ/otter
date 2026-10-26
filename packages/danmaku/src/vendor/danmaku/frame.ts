// Derived from danmaku@e91bd7ad2ef6c1f8d6bc40d71698594696996e1e src/engine/index.js, MIT
// Derived from danmaku@e91bd7ad2ef6c1f8d6bc40d71698594696996e1e src/internal/seek.js, MIT
//
// Copyright (c) 2014 Zhenye Wei. MIT License. One frame of the engine: comments past their
// duration leave, comments whose time has come enter (each allocated a track), and every running
// comment is placed. Positions come from media time only (upstream moves them on a wall clock
// anchored at entry, scaled by playbackRate), so pause, seek and rate need no bookkeeping.
// Local changes are listed in ./UPSTREAM.json.

import { allocate, binsearch, resetSpace, type Allocatable, type Space, type Stage } from './allocate.js';

export interface Placed extends Allocatable {
  x: number;
  y: number;
}

export interface FrameState<C extends Placed> {
  /** Sorted by time. */
  comments: readonly C[];
  /** Next comment to enter. */
  position: number;
  running: C[];
  space: Space;
}

export interface FrameHooks<C extends Placed> {
  /** Settings filters (mode hidden, blocked words, density): false skips the comment. */
  accept(c: C): boolean;
  /** Before allocation: measure (width / height) and prepare the sprite. */
  setup(c: C): void;
  remove(c: C): void;
}

const durationOf = (c: Allocatable, stage: Stage): number => (c.mode === 'top' || c.mode === 'bottom' ? stage.fixedDuration : stage.duration);

/**
 * Starts over at media time `ct` (seek, resize, settings): the comments that would be on the
 * stage now enter again, mid-flight (upstream drops them and starts at `ct`).
 */
export function rebuild<C extends Placed>(s: FrameState<C>, ct: number, stage: Stage, hooks: FrameHooks<C>): void {
  for (const c of s.running) hooks.remove(c);
  s.running = [];
  s.space = resetSpace();
  s.position = binsearch(s.comments, ct - Math.max(stage.duration, stage.fixedDuration));
  while (s.position > 0 && (s.comments[s.position - 1] as C).time >= ct - Math.max(stage.duration, stage.fixedDuration)) s.position--;
}

/** Advances to media time `ct` and places every running comment (x, y in stage px). */
export function frame<C extends Placed>(s: FrameState<C>, ct: number, stage: Stage, hooks: FrameHooks<C>): void {
  for (let i = s.running.length - 1; i >= 0; i--) {
    const c = s.running[i] as C;
    if (ct - c.time > durationOf(c, stage)) {
      hooks.remove(c);
      s.running.splice(i, 1);
    }
  }
  while (s.position < s.comments.length) {
    const c = s.comments[s.position] as C;
    if (c.time > ct) break;
    s.position++;
    // Already gone (after a seek or a long frame gap): skipped, as upstream.
    if (ct - c.time > durationOf(c, stage) || !hooks.accept(c)) continue;
    hooks.setup(c);
    c.y = allocate(s.space, c, ct, stage);
    if (c.y < 0) hooks.remove(c);
    else s.running.push(c);
  }
  for (const c of s.running) {
    const elapsed = ((stage.width + c.width) * (ct - c.time)) / stage.duration;
    c.x = c.mode === 'ltr' ? elapsed - c.width : c.mode === 'rtl' ? stage.width - elapsed : (stage.width - c.width) / 2;
  }
}
