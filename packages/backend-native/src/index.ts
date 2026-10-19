// Native backend (SPEC §6.1): `<video src>` for progressive files and Safari native HLS. Keeps
// AirPlay, native PiP and the power-efficient system pipeline; quality is opaque to the page.

import { createError, createEventBus, type Unsubscribe } from '@otter-player/core';
import {
  EMPTY_TIME_RANGES,
  EMPTY_TRACKS,
  mediaElementError,
  observeMediaElement,
  type AudioTrack,
  type BackendContext,
  type BackendEvents,
  type BackendFactory,
  type MediaBackend,
  type MediaElementObserver,
  type TextTrackInfo,
  type TrackList,
  type VideoTrack,
} from '@otter-player/media';

export interface NativeBackendOptions {
  /** Set `disableRemotePlayback` instead of offering AirPlay / Remote Playback. */
  readonly disableRemotePlayback?: boolean;
}

/** Safari exposes these; they are not in the standard DOM typings. */
interface NativeTrackLike {
  readonly id: string;
  readonly label: string;
  readonly language: string;
  readonly enabled?: boolean;
  readonly selected?: boolean;
}
interface NativeTrackList {
  readonly length: number;
  [index: number]: NativeTrackLike | undefined;
}

const TEXT_ROLES: Readonly<Record<string, TextTrackInfo['role']>> = {
  subtitles: 'subtitles',
  captions: 'captions',
  descriptions: 'descriptions',
  chapters: 'chapters',
  metadata: 'metadata',
};

function listOf(list: NativeTrackList | undefined): NativeTrackLike[] {
  const out: NativeTrackLike[] = [];
  for (let i = 0; i < (list?.length ?? 0); i++) {
    const t = list?.[i];
    if (t !== undefined) out.push(t);
  }
  return out;
}

const withLabel = <T extends object>(t: T, label: string, language: string): T =>
  ({ ...t, ...(label === '' ? {} : { label }), ...(language === '' ? {} : { language }) });

/** Reads the element track lists; quality switching is never available natively. */
export function readNativeTracks(media: HTMLMediaElement): TrackList {
  const el = media as HTMLMediaElement & { videoTracks?: NativeTrackList; audioTracks?: NativeTrackList };
  const video: VideoTrack[] = listOf(el.videoTracks).map((t, i) =>
    withLabel({ kind: 'video', id: t.id === '' ? `video-${i}` : t.id, selected: t.selected === true }, t.label, t.language),
  );
  const audio: AudioTrack[] = listOf(el.audioTracks).map((t, i) =>
    withLabel({ kind: 'audio', id: t.id === '' ? `audio-${i}` : t.id, selected: t.enabled === true }, t.label, t.language),
  );
  const text: TextTrackInfo[] = [];
  for (let i = 0; i < media.textTracks.length; i++) {
    const t = media.textTracks[i];
    if (t === undefined) continue;
    text.push(
      withLabel(
        { kind: 'text', id: t.id === '' ? `text-${i}` : t.id, role: TEXT_ROLES[t.kind] ?? 'subtitles', selected: t.mode === 'showing' },
        t.label,
        t.language,
      ),
    );
  }
  return { ...EMPTY_TRACKS, video, audio, text, quality: 'opaque' };
}

/** Seconds behind the live edge for native live streams (seekable end minus playhead). */
function liveLatency(m: HTMLMediaElement | undefined): number | undefined {
  if (m === undefined || m.duration !== Number.POSITIVE_INFINITY || m.seekable.length === 0) return undefined;
  return Math.max(0, m.seekable.end(m.seekable.length - 1) - m.currentTime);
}

export function createNativeBackend(_ctx: BackendContext, options: NativeBackendOptions = {}): MediaBackend {
  const bus = createEventBus<BackendEvents>();
  const emit = <E extends keyof BackendEvents>(e: E, p: BackendEvents[E]): void => bus.emit(e, p);
  let media: HTMLMediaElement | undefined;
  let observer: MediaElementObserver | undefined;
  let objectUrl: string | undefined;
  let tracks: TrackList = EMPTY_TRACKS;
  const offs: Unsubscribe[] = [];

  const element = (): HTMLMediaElement => {
    if (media === undefined) {
      throw createError({ type: 'other', details: 'backendNotAttached', fatal: true, recoverable: false });
    }
    return media;
  };

  const refreshTracks = (): void => {
    tracks = readNativeTracks(element());
    emit('tracks-change', tracks);
  };

  const listen = (target: EventTarget | undefined, type: string, h: () => void): void => {
    if (target === undefined) return;
    target.addEventListener(type, h);
    offs.push(() => target.removeEventListener(type, h));
  };

  return {
    kind: 'native',
    get tracks() {
      return tracks;
    },
    get buffered() {
      return media?.buffered ?? EMPTY_TIME_RANGES;
    },
    get latency() {
      return liveLatency(media);
    },
    attach(target) {
      if (!('canPlayType' in target)) {
        throw createError({ type: 'other', details: 'unsupportedTarget', fatal: true, recoverable: false, message: 'native backend needs a media element' });
      }
      media = target;
      observer = observeMediaElement(target, emit);
      const el = target as HTMLMediaElement & { videoTracks?: EventTarget; audioTracks?: EventTarget };
      for (const list of [el.videoTracks, el.audioTracks, target.textTracks]) {
        listen(list, 'addtrack', refreshTracks);
        listen(list, 'removetrack', refreshTracks);
        listen(list, 'change', refreshTracks);
      }
      listen(target, 'timeupdate', () => {
        const latency = liveLatency(media);
        if (latency !== undefined) emit('latency-change', { latency });
      });
    },
    load(source, opts) {
      const m = element();
      if (options.disableRemotePlayback === true) m.disableRemotePlayback = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
      objectUrl = typeof source.src === 'string' ? undefined : URL.createObjectURL(source.src);
      return new Promise<void>((resolve, reject) => {
        const done = (): void => {
          m.removeEventListener('loadedmetadata', onMeta);
          m.removeEventListener('error', onError);
          opts.signal?.removeEventListener('abort', onAbort);
        };
        const onMeta = (): void => {
          done();
          if (opts.startTime !== undefined && opts.startTime > 0) m.currentTime = opts.startTime;
          refreshTracks();
          resolve();
        };
        const onError = (): void => {
          done();
          reject(mediaElementError(m.error));
        };
        const onAbort = (): void => {
          done();
          reject(createError({ type: 'other', details: 'loadAborted', fatal: false, recoverable: true }));
        };
        m.addEventListener('loadedmetadata', onMeta);
        m.addEventListener('error', onError);
        opts.signal?.addEventListener('abort', onAbort);
        m.preload = 'auto';
        m.src = objectUrl ?? (source.src as string);
        m.load();
      });
    },
    play: () => element().play(),
    pause: () => element().pause(),
    seek(t) {
      element().currentTime = t;
    },
    setVolume(v) {
      element().volume = v;
    },
    setMuted(m) {
      element().muted = m;
    },
    setPlaybackRate(r) {
      element().playbackRate = r;
    },
    // Quality is opaque on the native path (tracks.quality === 'opaque').
    selectQuality: () => undefined,
    seekToLive() {
      // Native HLS: the live edge is the end of the seekable range; stay a target duration-ish
      // (3 s) behind it so playback does not immediately stall.
      const m = media;
      if (m === undefined || m.seekable.length === 0) return;
      const end = m.seekable.end(m.seekable.length - 1);
      m.currentTime = Math.max(m.seekable.start(0), end - 3);
    },
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy() {
      observer?.destroy();
      for (const off of offs.splice(0)) off();
      bus.clear();
      if (media !== undefined) {
        media.removeAttribute('src');
        media.load();
      }
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
      objectUrl = undefined;
      media = undefined;
    },
  };
}

export function createNativeBackendFactory(options: NativeBackendOptions = {}): BackendFactory {
  return { kind: 'native', create: (ctx) => createNativeBackend(ctx, options) };
}
