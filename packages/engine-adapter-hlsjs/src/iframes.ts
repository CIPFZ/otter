// Seek-preview pictures from an HLS I-frame playlist (ADR-007 §7): hls.js' I-frame player (L1)
// renders into an off-screen <video>; each frame is copied to a canvas for the preview card.
// At most one load per 200 ms; the latest request wins and earlier callers get its frame.

import type { Thumbnail, ThumbnailProvider } from '@otter-player/media';
import type Hls from 'hls.js';

const THROTTLE_MS = 200;
const FRAME_TIMEOUT_MS = 2000;

type IFramePlayer = NonNullable<ReturnType<Hls['createIFramePlayer']>>;

/** The buffered range of `v` around `time` (an I-frame covers its whole segment). */
function buffered(v: HTMLVideoElement, time: number): [number, number] | undefined {
  for (let i = 0; i < v.buffered.length; i++) {
    const start = v.buffered.start(i);
    const end = v.buffered.end(i);
    if (start <= time + 0.05 && time < end) return [start, end];
  }
  return undefined;
}

export interface IFrameThumbnails extends ThumbnailProvider {
  destroy(): void;
}

/** Null when the stream has no I-frame variants. */
export function createIFrameThumbnails(hls: Hls, doc: Document): IFrameThumbnails | null {
  if (hls.iframeVariants.length === 0) return null;
  let player: IFramePlayer | null | undefined;
  let attached: Promise<unknown> = Promise.resolve();
  let video: HTMLVideoElement | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let wanted: number | undefined;
  let waiters: ((t: Thumbnail | null) => void)[] = [];
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastLoad = Number.NEGATIVE_INFINITY;
  let destroyed = false;

  const frame = (time: number): Promise<Thumbnail | null> => {
    if (player === undefined) {
      player = hls.createIFramePlayer();
      if (player !== null) {
        video = doc.createElement('video');
        video.muted = true;
        video.playsInline = true;
        // hls.js 1.7 race: if the I-frame playlist loads before the MediaSource opens, no fragment
        // is ever requested. Start loading only once the media is attached.
        const p = player;
        attached = new Promise((r) => p.once((hls.constructor as typeof Hls).Events.MEDIA_ATTACHED, r));
        player.attachMedia(video);
      }
    }
    const v = video;
    const p = player;
    if (p === null || v === undefined) return Promise.resolve(null);
    return attached.then(() => new Promise((resolve) => {
      const started = performance.now();
      // hls.js seeks the I-frame media itself once the fragment is in, except on the first load
      // of a fresh player (1.7: the pending seek is dropped). Watch the buffer and seek there when
      // hls.js has not.
      const poll = setInterval(() => {
        const range = buffered(v, time);
        if (destroyed || performance.now() - started > FRAME_TIMEOUT_MS) return done(false);
        if (range === undefined || v.seeking) return;
        if (v.currentTime < range[0] || v.currentTime > range[1]) {
          v.currentTime = Math.min(Math.max(time, range[0]), range[1] - 0.01);
          return;
        }
        if (v.readyState >= 2) done(true);
      }, 50);
      const done = (ok: boolean): void => {
        clearInterval(poll);
        if (!ok || destroyed || v.videoWidth === 0) return resolve(null);
        canvas ??= doc.createElement('canvas');
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        canvas.getContext('2d')?.drawImage(v, 0, 0);
        resolve({ bitmap: canvas });
      };
      p.loadMediaAt(time);
    }));
  };

  const pump = (): void => {
    if (busy || wanted === undefined || timer !== undefined || destroyed) return;
    const wait = lastLoad + THROTTLE_MS - performance.now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, wait);
      return;
    }
    const time = wanted;
    const ws = waiters;
    wanted = undefined;
    waiters = [];
    busy = true;
    lastLoad = performance.now();
    void frame(time).then((t) => {
      busy = false;
      for (const w of ws) w(t);
      pump();
    });
  };

  return {
    at(time) {
      if (destroyed) return Promise.resolve(null);
      wanted = time;
      return new Promise((resolve) => {
        waiters.push(resolve);
        pump();
      });
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      for (const w of waiters.splice(0)) w(null);
      player?.destroy();
      player = undefined;
    },
  };
}
