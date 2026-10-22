// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/controller/abr-controller.ts, Apache-2.0
//
// Copyright (c) 2017 Dailymotion (http://www.dailymotion.com). Licensed under the Apache License,
// Version 2.0. AbrController._abandonRulesCheck and getTimeToLoadFrag as one pure decision over a
// snapshot of the download in flight: the caller aborts the request and loads the returned level.
// Local changes are listed in ./UPSTREAM.json.

export interface AbandonSnapshot {
  /** ms since the request started. */
  readonly timeLoadingMs: number;
  /** ms to the first byte, -1 before it. */
  readonly ttfbMs: number;
  readonly loadedBytes: number;
  /** Size of the segment (Content-Length, else duration x bitrate / 8). */
  readonly expectedBytes: number;
  /** Segment duration, seconds. */
  readonly durationS: number;
  /** Seconds of media buffered ahead of the playhead. */
  readonly bufferS: number;
  readonly playbackRate: number;
  /** Bandwidth estimate, bits per second. */
  readonly bandwidthBps: number;
  /** Time-to-first-byte estimate, ms. */
  readonly ttfbEstimateMs: number;
  /** Peak bitrates of the levels, ascending (level 0 lowest). */
  readonly bitrates: readonly number[];
  /** Level (index into `bitrates`) of the segment loading. */
  readonly level: number;
  /** A switch needs the level's media playlist first (live, or not loaded yet). */
  readonly requiresLevelLoad: (level: number) => boolean;
  /** Seconds a media playlist load takes (hls.js lastLevelLoadSec). */
  readonly levelLoadS: number;
}

export interface AbandonDecision {
  readonly level: number;
  /** Seconds to finish the segment loading now, and to load one at `level`. */
  readonly fragLoadedDelay: number;
  readonly nextLoadDelay: number;
  readonly bufferS: number;
  /** Measured load rate of the request, bits per second (0 before the first byte). */
  readonly loadRateBps: number;
}

/** getTimeToLoadFrag: seconds to load `fragSizeBits` at `bandwidth`, plus its playlist when switching. */
function timeToLoadFrag(ttfbS: number, bandwidth: number, fragSizeBits: number, isSwitch: boolean, levelLoadS: number): number {
  const fragLoadSec = ttfbS + fragSizeBits / bandwidth;
  const playlistLoadSec = isSwitch ? ttfbS + levelLoadS : 0;
  return fragLoadSec + playlistLoadSec;
}

/**
 * _abandonRulesCheck: the level to switch down to when the segment in flight would not finish
 * before the buffer runs out, undefined to keep loading it. Upstream's playing / paused gate and
 * its estimator resets are the caller's.
 */
export function abandonCheck(s: AbandonSnapshot): AbandonDecision | undefined {
  const minAutoLevel = 0;
  if (s.level <= minAutoLevel || s.loadedBytes >= s.expectedBytes) return undefined;
  const playbackRate = Math.abs(s.playbackRate) || 1;
  // To maintain stable adaptive playback, only begin monitoring frag loading after half or more of its playback duration has passed
  if (s.timeLoadingMs <= Math.max(s.ttfbEstimateMs, 1000 * (s.durationS / (playbackRate * 2)))) return undefined;
  // bufferStarvationDelay is an estimate of the amount time (in seconds) it will take to exhaust the buffer
  const bufferStarvationDelay = s.bufferS / playbackRate;
  const loadedFirstByte = s.loadedBytes > 0 && s.ttfbMs > -1;
  let timeStreaming = loadedFirstByte ? s.timeLoadingMs - s.ttfbMs : s.timeLoadingMs;
  if (timeStreaming < 1 && loadedFirstByte) timeStreaming = Math.min(s.timeLoadingMs, (s.loadedBytes * 8) / s.bandwidthBps);
  const loadRate = loadedFirstByte ? (s.loadedBytes * 1000) / timeStreaming : 0;
  // fragLoadDelay is an estimate of the time (in seconds) it will take to buffer the remainder of the fragment
  const ttfbSeconds = s.ttfbEstimateMs / 1000;
  const fragLoadedDelay = loadRate ? (s.expectedBytes - s.loadedBytes) / loadRate : (s.expectedBytes * 8) / s.bandwidthBps + ttfbSeconds;
  // Only downswitch if the time to finish loading the current fragment is greater than the amount of buffer left
  if (fragLoadedDelay <= bufferStarvationDelay) return undefined;
  const bwe = loadRate ? loadRate * 8 : s.bandwidthBps;
  let fragLevelNextLoadedDelay = Number.POSITIVE_INFINITY;
  let nextLoadLevel: number;
  // Iterate through lower level and try to find the largest one that avoids rebuffering
  for (nextLoadLevel = s.level - 1; nextLoadLevel > minAutoLevel; nextLoadLevel--) {
    // compute time to load next fragment at lower level
    // 8 = bits per byte (bps/Bps)
    const levelNextBitrate = s.bitrates[nextLoadLevel] as number;
    fragLevelNextLoadedDelay = timeToLoadFrag(ttfbSeconds, bwe, s.durationS * levelNextBitrate, s.requiresLevelLoad(nextLoadLevel), s.levelLoadS);
    if (fragLevelNextLoadedDelay < Math.min(bufferStarvationDelay, s.durationS + ttfbSeconds)) break;
  }
  // Otter: upstream's loop stops above the lowest level and leaves the delay of the level above it;
  // the lowest level's own delay is what the comparison below needs when the loop ran out.
  if (nextLoadLevel === minAutoLevel) {
    fragLevelNextLoadedDelay = timeToLoadFrag(ttfbSeconds, bwe, s.durationS * (s.bitrates[minAutoLevel] as number), s.requiresLevelLoad(minAutoLevel), s.levelLoadS);
  }
  // Only emergency switch down if it takes less time to load a new fragment at lowest level instead of continuing
  // to load the current one
  if (fragLevelNextLoadedDelay >= fragLoadedDelay) return undefined;
  // if estimated load time of new segment is completely unreasonable, ignore and do not emergency switch down
  if (fragLevelNextLoadedDelay > s.durationS * 10) return undefined;
  return { level: nextLoadLevel, fragLoadedDelay, nextLoadDelay: fragLevelNextLoadedDelay, bufferS: bufferStarvationDelay, loadRateBps: loadRate * 8 };
}
