// Preset `background` (SPEC §19「背景视频 / Hero」, ≤ 5 KB): a muted, looping, inline <video> with no
// UI and no routing: the browser plays the MP4 itself. Only the element's state goes into a store
// (createStore + observeMediaElement), so a page can still follow it (first frame, errors); the
// playback session, router and fallback chain are not here (ADR-013, handoff §2). A file the
// browser cannot play leaves the poster.

import { createStore, type StoreView } from '@otter-player/core';
import { MEDIA_SLICE, observeMediaElement, type MediaState } from '@otter-player/media';

export interface BackgroundOptions {
  /** The <video> to use, or a container to put one in (it fills the container). */
  readonly target: HTMLVideoElement | HTMLElement;
  /** MP4 (or any type the browser plays natively). */
  readonly src: string;
  readonly poster?: string;
  /** Default true. */
  readonly loop?: boolean;
  /** Start playing (muted) unless the viewer asked for reduced motion. Default true. */
  readonly autoplay?: boolean;
}

export interface BackgroundPlayer {
  readonly video: HTMLVideoElement;
  /** Element state (paused, currentTime, readyState, error...), read-only. */
  readonly store: StoreView<MediaState, Record<never, never>>;
  play(): Promise<void>;
  pause(): void;
  destroy(): void;
}

export function createBackgroundPlayer(options: BackgroundOptions): BackgroundPlayer {
  let video: HTMLVideoElement;
  if (options.target instanceof HTMLVideoElement) video = options.target;
  else {
    video = options.target.ownerDocument.createElement('video');
    video.style.cssText = 'width:100%;height:100%;object-fit:cover';
    options.target.append(video);
  }
  // Decorative: hidden from assistive technology, never a tab stop.
  video.setAttribute('aria-hidden', 'true');
  video.tabIndex = -1;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.loop = options.loop !== false;
  if (options.poster !== undefined) video.poster = options.poster;
  const store = createStore<MediaState>({ slices: [MEDIA_SLICE] });
  const observer = observeMediaElement(video, (event, payload) => {
    if (event === 'playback-change') store.setState(payload as Partial<MediaState>);
    else if (event === 'first-frame') store.setState({ status: 'ready' });
    else if (event === 'error') store.setState({ status: 'error', error: payload as MediaState['error'] });
  });
  store.setState({ status: 'loading', source: { src: options.src } });
  video.src = options.src;
  const reduced = video.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const play = (): Promise<void> => video.play().catch(() => undefined);
  if (options.autoplay !== false && !reduced) void play();
  return {
    video,
    store: store.view(),
    play,
    pause: () => video.pause(),
    destroy() {
      observer.destroy();
      store.destroy();
      video.removeAttribute('src');
      video.load();
    },
  };
}
