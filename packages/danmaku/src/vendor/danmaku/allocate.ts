// Derived from danmaku@e91bd7ad2ef6c1f8d6bc40d71698594696996e1e src/internal/allocate.js, MIT
// Derived from danmaku@e91bd7ad2ef6c1f8d6bc40d71698594696996e1e src/utils.js, MIT
//
// Copyright (c) 2014 Zhenye Wei. MIT License. The track allocator: per mode, the occupied ranges
// sorted by their top edge; a new comment takes the first gap tall enough, or the range after the
// last one it would collide with. Times are media seconds (upstream's media-bound timeline).
// Local changes are listed in ./UPSTREAM.json.

export type Mode = 'rtl' | 'ltr' | 'top' | 'bottom';

/** One occupied range of a track space. */
interface Range {
  readonly range: number;
  readonly time: number;
  readonly width: number;
  readonly height: number;
}

export type Space = Record<Mode, Range[]>;

/** What allocation needs to know about a comment. */
export interface Allocatable {
  readonly mode: Mode;
  /** Media seconds it entered. */
  readonly time: number;
  readonly width: number;
  readonly height: number;
}

/** The stage: width and the usable height (display area), px; durations in media seconds. */
export interface Stage {
  readonly width: number;
  readonly height: number;
  /** Seconds a scrolling comment takes across the stage. */
  readonly duration: number;
  /** Seconds a top / bottom comment stays. */
  readonly fixedDuration: number;
}

const MAX = 9007199254740991;
const collidableRange = (): Range[] => [
  { range: 0, time: -MAX, width: MAX, height: 0 },
  { range: MAX, time: MAX, width: 0, height: 0 },
];

export function resetSpace(): Space {
  return { ltr: collidableRange(), rtl: collidableRange(), top: collidableRange(), bottom: collidableRange() };
}

/** First index whose `time` is greater than `key` (upstream binsearch). */
export function binsearch(arr: readonly { readonly time: number }[], key: number): number {
  let left = 0;
  let right = arr.length;
  while (left < right - 1) {
    const mid = (left + right) >> 1;
    if (key >= (arr[mid] as { time: number }).time) left = mid;
    else right = mid;
  }
  if (arr[left] !== undefined && key < (arr[left] as { time: number }).time) return left;
  return right;
}

/**
 * The y of `cmt` at media time `ct`, recorded in `space`; -1 when the display area has no room
 * (upstream wraps around and overlaps instead).
 */
export function allocate(space: Space, cmt: Allocatable, ct: number, stage: Stage): number {
  const fixed = cmt.mode === 'top' || cmt.mode === 'bottom';
  const willCollide = (cr: Range): boolean => {
    if (fixed) return ct - cr.time < stage.fixedDuration;
    const crTotalWidth = stage.width + cr.width;
    const crElapsed = (crTotalWidth * (ct - cr.time)) / stage.duration;
    if (cr.width > crElapsed) return true;
    // The far end of `cr` leaves the stage before the near end of `cmt` arrives there.
    const crLeftTime = stage.duration + cr.time - ct;
    const cmtTotalWidth = stage.width + cmt.width;
    const cmtElapsed = (cmtTotalWidth * (ct - cmt.time)) / stage.duration;
    const cmtArrival = stage.width - cmtElapsed;
    const cmtArrivalTime = (stage.duration * cmtArrival) / (stage.width + cmt.width);
    return crLeftTime > cmtArrivalTime;
  };
  const crs = space[cmt.mode];
  let last = 0;
  let curr = 0;
  for (let i = 1; i < crs.length; i++) {
    const cr = crs[i] as Range;
    let requiredRange = cmt.height;
    if (fixed) requiredRange += cr.height;
    if (cr.range - cr.height - (crs[last] as Range).range >= requiredRange) {
      curr = i;
      break;
    }
    if (willCollide(cr)) last = i;
  }
  const channel = (crs[last] as Range).range;
  // Otter: full display area, no overlap (B站 "防重叠").
  if (channel + cmt.height > stage.height) return -1;
  crs.splice(last + 1, curr - last - 1, { range: channel + cmt.height, time: cmt.time, width: cmt.width, height: cmt.height });
  return cmt.mode === 'bottom' ? stage.height - cmt.height - channel : channel;
}
