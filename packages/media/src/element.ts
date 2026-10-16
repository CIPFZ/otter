// Shared <video>/<audio> observation for element-based backends (native, mse): maps element events
// to BackendEvents so the playback session never listens to the element itself (ADR-003 §2).

import { createError, type OtterError } from '@otter-player/core';
import type { BackendEvents, PlaybackSnapshot } from './backend.js';

export type BackendEmit = <E extends keyof BackendEvents>(e: E, payload: BackendEvents[E]) => void;

export interface MediaElementObserver {
  snapshot(): PlaybackSnapshot;
  destroy(): void;
}

export interface ObserveOptions {
  /** Poll interval for getVideoPlaybackQuality while playing, ms. */
  readonly droppedFramesIntervalMs?: number;
  readonly now?: () => number;
}

/** End of the buffered range that contains `time`, else the last buffered end. */
export function bufferedEndAt(buffered: TimeRanges, time: number): number {
  let end = 0;
  for (let i = 0; i < buffered.length; i++) {
    end = buffered.end(i);
    if (buffered.start(i) <= time && time <= end) return end;
  }
  return end;
}

const MEDIA_ERROR_DETAILS: Readonly<Record<number, readonly [OtterError['type'], string]>> = {
  1: ['media', 'mediaAborted'],
  2: ['network', 'mediaNetworkError'],
  3: ['media', 'mediaDecodeError'],
  4: ['media', 'mediaSrcNotSupported'],
};

/** Maps `HTMLMediaElement.error` to the unified error model. Element errors are fatal. */
export function mediaElementError(error: MediaError | null): OtterError {
  const [type, details] = MEDIA_ERROR_DETAILS[error?.code ?? 0] ?? (['media', 'mediaError'] as const);
  return createError({
    type,
    details,
    fatal: true,
    recoverable: details === 'mediaDecodeError',
    message: error?.message !== undefined && error.message !== '' ? error.message : details,
  });
}

export function observeMediaElement(
  media: HTMLMediaElement,
  emit: BackendEmit,
  options: ObserveOptions = {},
): MediaElementObserver {
  const now = options.now ?? (() => performance.now());
  const interval = options.droppedFramesIntervalMs ?? 1000;
  const video = media as HTMLVideoElement;
  let waiting = false;
  let firstFrame = false;
  let lastDropped = -1;
  let timer: ReturnType<typeof setInterval> | undefined;

  const snapshot = (): PlaybackSnapshot => ({
    paused: media.paused,
    ended: media.ended,
    seeking: media.seeking,
    waiting,
    currentTime: media.currentTime,
    duration: media.duration,
    bufferedEnd: bufferedEndAt(media.buffered, media.currentTime),
    volume: media.volume,
    muted: media.muted,
    playbackRate: media.playbackRate,
    videoWidth: video.videoWidth ?? 0,
    videoHeight: video.videoHeight ?? 0,
    readyState: media.readyState,
  });

  const pollDropped = (): void => {
    const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : undefined;
    if (quality === undefined || quality.droppedVideoFrames === lastDropped) return;
    lastDropped = quality.droppedVideoFrames;
    emit('dropped-frames', { dropped: quality.droppedVideoFrames, total: quality.totalVideoFrames });
  };
  const startPolling = (): void => {
    if (timer === undefined) timer = setInterval(pollDropped, interval);
  };
  const stopPolling = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  const handlers: Readonly<Record<string, () => void>> = {
    play: () => emit('playback-change', { paused: false, ended: false }),
    playing: () => {
      waiting = false;
      startPolling();
      emit('playback-change', { paused: false, waiting: false, readyState: media.readyState });
    },
    pause: () => {
      stopPolling();
      pollDropped();
      emit('playback-change', { paused: true });
    },
    waiting: () => {
      waiting = true;
      emit('playback-change', { waiting: true, readyState: media.readyState });
      emit('waiting', { position: media.currentTime });
    },
    stalled: () => emit('stalled', { position: media.currentTime }),
    seeking: () => emit('playback-change', { seeking: true, currentTime: media.currentTime }),
    seeked: () => emit('playback-change', { seeking: false, currentTime: media.currentTime }),
    timeupdate: () => emit('playback-change', { currentTime: media.currentTime }),
    durationchange: () => emit('playback-change', { duration: media.duration }),
    progress: () => {
      emit('buffered-change', { buffered: media.buffered });
      emit('playback-change', { bufferedEnd: bufferedEndAt(media.buffered, media.currentTime) });
    },
    volumechange: () => emit('playback-change', { volume: media.volume, muted: media.muted }),
    ratechange: () => emit('playback-change', { playbackRate: media.playbackRate }),
    loadedmetadata: () => emit('playback-change', snapshot()),
    resize: () => emit('playback-change', { videoWidth: video.videoWidth, videoHeight: video.videoHeight }),
    loadeddata: () => {
      if (!firstFrame) {
        firstFrame = true;
        emit('first-frame', { at: now() });
      }
      emit('playback-change', { readyState: media.readyState });
    },
    ended: () => {
      stopPolling();
      emit('playback-change', { ended: true, paused: media.paused });
      emit('ended', { position: media.currentTime });
    },
    error: () => emit('error', mediaElementError(media.error)),
  };

  for (const [type, handler] of Object.entries(handlers)) media.addEventListener(type, handler);

  return {
    snapshot,
    destroy() {
      stopPolling();
      for (const [type, handler] of Object.entries(handlers)) media.removeEventListener(type, handler);
    },
  };
}
