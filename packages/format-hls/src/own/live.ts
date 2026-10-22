// Live part of the own CMAF-HLS engine (ADR-010 §4), a chunk of its own: VOD never loads it.
// Reloads the media playlists on SPF's reload policy, keeps the DVR window on the MediaSource
// (setLiveSeekableRange), and steers latency with the LiveController against the playlist's live
// edge (LiveSample.edge), the target being HOLD-BACK (default 3 x TARGETDURATION).

import { createLiveController, type LiveAction, type LiveSample } from '@otter-player/pipeline';
import { liveLatencyFor, mediaPlaylistReloadDelay } from '../vendor/video.js/media/hls/reload-policy.js';
import type { ResolvedTrack } from '../vendor/video.js/media/types/index.js';

export interface LiveHooks {
  readonly media: HTMLMediaElement;
  readonly mediaSource: MediaSource;
  /** Host override of the target latency, seconds. */
  readonly targetLatency?: number;
  /** The playing video rendition (its HOLD-BACK is the target). */
  track(): ResolvedTrack;
  /** The DVR window on the media timeline, undefined before the first segment's timing is known. */
  window(): { readonly start: number; readonly end: number } | undefined;
  /** Reloads the playing media playlists: [before, after] per rendition. */
  refresh(): Promise<readonly (readonly [ResolvedTrack, ResolvedTrack])[]>;
  /** ENDLIST arrived: no more reloads. */
  ended(): void;
}

export interface Live {
  /** Playlist time to start at: HOLD-BACK behind the edge, inside the window. */
  readonly startAt: number;
  readonly latency: number | undefined;
  readonly targetLatency: number;
  seekToLive(): void;
  destroy(): void;
}

const ranges = (t: TimeRanges): [number, number][] => Array.from({ length: t.length }, (_, i) => [t.start(i), t.end(i)]);

export function startLive(h: LiveHooks): Live {
  const media = h.media;
  const holdBack = (): number => liveLatencyFor(h.track());
  const lc = createLiveController({ targetLatency: h.targetLatency ?? holdBack() });
  const first = h.track();
  const startAt = Math.max(first.segments[0]?.startTime ?? 0, (first.segments.at(-1)?.startTime ?? 0) + (first.segments.at(-1)?.duration ?? 0) - lc.targetLatency);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let canPlay = false;

  const sample = (): LiveSample => {
    const w = h.window();
    return {
      currentTime: media.currentTime,
      paused: media.paused,
      buffered: ranges(media.buffered),
      playbackRate: media.playbackRate,
      readyState: media.readyState,
      ...(w === undefined ? {} : { edge: w.end }),
    };
  };
  const apply = (a: LiveAction | undefined): void => {
    if (a === undefined) return;
    if (a.type === 'seek') media.currentTime = a.to;
    else media.playbackRate = a.rate;
  };
  const seekable = (): void => {
    const w = h.window();
    if (w === undefined || h.mediaSource.readyState !== 'open') return;
    try {
      h.mediaSource.setLiveSeekableRange(w.start, w.end);
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
  media.addEventListener('timeupdate', onTime);
  media.addEventListener('canplay', onCanPlay);
  media.addEventListener('stalled', onStalled);

  const tick = (delay: number): void => {
    timer = setTimeout(() => {
      void h.refresh().then(
        (pairs) => {
          if (stopped) return;
          seekable();
          if (h.targetLatency === undefined) lc.setTargetLatency(holdBack());
          // SPF's policy: a target duration after a change, half of it after an unchanged reload.
          const delays = pairs.map(([before, after]) => mediaPlaylistReloadDelay(after, before)).filter((d): d is number => d !== null);
          if (delays.length > 0) tick(Math.min(...delays));
          else h.ended();
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
    startAt,
    get latency() {
      const w = h.window();
      return w === undefined ? undefined : Math.max(0, w.end - media.currentTime);
    },
    get targetLatency() {
      return lc.targetLatency;
    },
    seekToLive: () => apply(lc.seekToLive(sample())),
    destroy() {
      stopped = true;
      clearTimeout(timer);
      media.removeEventListener('timeupdate', onTime);
      media.removeEventListener('canplay', onCanPlay);
      media.removeEventListener('stalled', onStalled);
    },
  };
}
