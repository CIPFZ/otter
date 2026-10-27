// Live part of the own CMAF-HLS engine (ADR-010 §4), a chunk of its own: VOD never loads it.
// Reloads the media playlists on SPF's reload policy, keeps the DVR window on the MediaSource
// (setLiveSeekableRange), and steers latency with the LiveController against the live edge
// (LiveSample.edge), the target being HOLD-BACK (default 3 x TARGETDURATION). The edge is where the
// stream is now, not where the last reload left it: with EXT-X-PROGRAM-DATE-TIME, the newest
// segment's start plus the wall-clock time since its capture; without, the playlist's end plus
// the time since that response arrived (at most 3 target durations, so stalled reloads do not
// run it away). The start position and back to live use the same edge.

import { createLiveController, type LiveAction, type LiveSample } from '@otter-player/pipeline';
import { liveLatencyFor, mediaPlaylistReloadDelay } from '../vendor/video.js/media/hls/reload-policy.js';
import { getMediaPlaylistMetadata, type ResolvedTrack } from '../vendor/video.js/media/types/index.js';
import type { EngineInner } from './engine.js';

/** `_` fields: internal to the package, short names in the build (AGENT.md §4, ADR-013). */
export interface Live {
  /** `fresh`'s segments moved onto `ref`'s timeline (a rendition loaded for the first time while live). */
  _align(fresh: ResolvedTrack, ref: ResolvedTrack | undefined): ResolvedTrack;
  /** Playlist time to start at: HOLD-BACK behind the edge, inside the window. */
  readonly _startAt: number;
  readonly _latency: number | undefined;
  readonly _targetLatency: number;
  _seekToLive(): void;
  _destroy(): void;
}

/** `fresh`'s segments moved onto `ref`'s timeline by a segment both have (same media sequence id). */
function align(fresh: ResolvedTrack, ref: ResolvedTrack | undefined): ResolvedTrack {
  if (ref === undefined) return fresh;
  const byId = new Map(ref.segments.map((s) => [s.id, s.startTime]));
  const common = fresh.segments.find((s) => byId.has(s.id));
  const shift = common === undefined ? (ref.segments[0]?.startTime ?? 0) - (fresh.segments[0]?.startTime ?? 0) : (byId.get(common.id) as number) - common.startTime;
  return shift === 0 ? fresh : { ...fresh, segments: fresh.segments.map((s) => ({ ...s, startTime: s.startTime + shift })) };
}

const ranges = (t: TimeRanges): [number, number][] => Array.from({ length: t.length }, (_, i) => [t.start(i), t.end(i)]);

export function startLive(h: EngineInner): Live {
  const media = h._media;
  const holdBack = (): number => liveLatencyFor(h._track());
  const lc = createLiveController({ targetLatency: h._targetLatency ?? holdBack() });
  let loadedAt = h._loadedAt;
  /** The live edge on the playlist timeline, now. */
  const edgeNow = (): number => {
    const t = h._track();
    const last = t.segments.at(-1);
    if (last === undefined) return 0;
    const end = last.startTime + last.duration;
    if (last.startDate !== undefined) return Math.max(end, last.startTime + (Date.now() / 1000 - last.startDate));
    const target = getMediaPlaylistMetadata(t)?.targetDuration ?? last.duration;
    return end + Math.min((performance.now() - loadedAt) / 1000, 3 * target);
  };
  const first = h._track();
  const startAt = Math.max(first.segments[0]?.startTime ?? 0, edgeNow() - lc.targetLatency);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let canPlay = false;

  /** Media time of the edge (window end is the playlist end on the media timeline). */
  const edge = (): number | undefined => {
    const w = h._window();
    return w === undefined ? undefined : w.end + edgeNow() - (h._track().segments.at(-1)?.startTime ?? 0) - (h._track().segments.at(-1)?.duration ?? 0);
  };
  const sample = (): LiveSample => {
    const e = edge();
    return {
      currentTime: media.currentTime,
      paused: media.paused,
      buffered: ranges(media.buffered),
      playbackRate: media.playbackRate,
      readyState: media.readyState,
      ...(e === undefined ? {} : { edge: e }),
    };
  };
  const apply = (a: LiveAction | undefined): void => {
    if (a === undefined) return;
    if (a.type === 'seek') media.currentTime = a.to;
    else media.playbackRate = a.rate;
  };
  const seekable = (): void => {
    const w = h._window();
    if (w === undefined || h._mediaSource.readyState !== 'open') return;
    try {
      h._mediaSource.setLiveSeekableRange(w.start, w.end);
    } catch {
      // Older engines without the API: seekable stays the buffered range.
    }
  };
  const onTime = (): void => apply(lc.sample(sample(), { canPlay }));
  const onCanPlay = (): void => {
    canPlay = true;
    onTime();
  };
  const onStalled = (): void => apply(lc.sample(sample(), { stalled: true, canPlay }));
  const onSeeking = (): void => lc.seeking(media.currentTime);
  media.addEventListener('seeking', onSeeking);
  media.addEventListener('timeupdate', onTime);
  media.addEventListener('canplay', onCanPlay);
  media.addEventListener('stalled', onStalled);

  const tick = (delay: number): void => {
    timer = setTimeout(() => {
      void h._refresh().then(
        (pairs) => {
          if (stopped) return;
          loadedAt = performance.now();
          seekable();
          if (h._targetLatency === undefined) lc.setTargetLatency(holdBack());
          // SPF's policy: a target duration after a change, half of it after an unchanged reload.
          const delays = pairs.map(([before, after]) => mediaPlaylistReloadDelay(after, before)).filter((d): d is number => d !== null);
          if (delays.length > 0) tick(Math.min(...delays));
          else h._ended();
        },
        () => {
          // A failed reload is retried at the next interval; the engine reports lasting errors.
          if (!stopped) tick(delay);
        },
      );
    }, delay);
  };
  seekable();
  tick(mediaPlaylistReloadDelay(first, undefined) ?? 2000);

  return {
    _align: align,
    _startAt: startAt,
    get _latency() {
      const e = edge();
      return e === undefined ? undefined : Math.max(0, e - media.currentTime);
    },
    get _targetLatency() {
      return lc.targetLatency;
    },
    _seekToLive: () => apply(lc.seekToLive(sample())),
    _destroy() {
      stopped = true;
      clearTimeout(timer);
      media.removeEventListener('seeking', onSeeking);
      media.removeEventListener('timeupdate', onTime);
      media.removeEventListener('canplay', onCanPlay);
      media.removeEventListener('stalled', onStalled);
    },
  };
}
