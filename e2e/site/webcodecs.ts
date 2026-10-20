// WebCodecs fixture (ADR-008 §2): core + the playback session with only format-file, the
// WebCodecs backend and decoder, drawing into a FrameSurface. window.wc lets e2e load a local
// clip as a Blob (format-file's input), seek, play, and read the frame number painted into it.

import { createCore, type QoeEventMap, type RouteExplanation } from '@otter-player/core';
import { createWebCodecsBackendFactory } from '@otter-player/backend-webcodecs';
import { createWebCodecsDecoder } from '@otter-player/decoder-webcodecs';
import { createFileFormat } from '@otter-player/format-file';
import { createMediaPlugin, MEDIA_SLICE, type MediaActionMap, type MediaState } from '@otter-player/media';
import { createQoePlugin, QOE_SLICE, type QoeState } from '@otter-player/qoe';
import { createFrameSurface } from '@otter-player/surface/gpu';

type State = MediaState & QoeState;

export interface WebCodecsFixture {
  /** Fetches /frames/<name> into a Blob and loads it; resolves when ready (or failed). */
  load(name: string, startTime?: number): Promise<{ status: string; route: RouteExplanation | null; error: unknown }>;
  dispatch<K extends keyof MediaActionMap>(type: K, payload: MediaActionMap[K]): boolean;
  /** Seeks and resolves when the seek finished, with its wall time in ms. */
  seek(time: number): Promise<number>;
  state(): MediaState;
  readonly surface: 'gpu' | 'canvas2d';
  readonly events: { type: string; payload: unknown }[];
}

declare global {
  interface Window {
    wc?: Promise<WebCodecsFixture>;
  }
}

const QOE_TYPES: (keyof QoeEventMap)[] = ['startup', 'rebuffer', 'error', 'dropped-frames', 'route', 'exit'];

async function start(): Promise<WebCodecsFixture> {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const surface = createFrameSurface(canvas);
  const media = createMediaPlugin<State, MediaActionMap>({
    target: document.querySelector('video') as HTMLVideoElement,
    formats: [createFileFormat()],
    backends: [createWebCodecsBackendFactory({ sink: surface })],
    decoders: [createWebCodecsDecoder()],
  });
  const core = createCore<State, MediaActionMap>({ slices: [MEDIA_SLICE, QOE_SLICE], plugins: [media, createQoePlugin()] });
  await core.start();
  const events: { type: string; payload: unknown }[] = [];
  for (const type of QOE_TYPES) core.qoe.on(type, (payload) => events.push({ type, payload }));
  const store = core.store;
  const settled = (pred: (s: MediaState) => boolean): Promise<void> =>
    new Promise((resolve) => {
      if (pred(store.getState())) return resolve();
      const off = store.subscribe((s) => {
        if (pred(s)) {
          off();
          resolve();
        }
      });
    });
  // A real button, so e2e can start playback inside a user gesture (AudioContext autoplay policy).
  (document.getElementById('play') as HTMLButtonElement).addEventListener('click', () => store.dispatch('toggle-paused', {}));
  return {
    surface: surface.kind,
    events,
    async load(name, startTime) {
      const blob = await (await fetch(`/frames/${name}`)).blob();
      store.dispatch('load', { source: { src: blob }, options: startTime === undefined ? {} : { startTime } });
      await settled((s) => s.status === 'ready' || s.status === 'error');
      const s = store.getState();
      return { status: s.status, route: s.route, error: s.error === null ? null : { ...s.error, message: String((s.error as unknown as Error).message) } };
    },
    dispatch: (type, payload) => store.dispatch(type, payload),
    async seek(time) {
      const t0 = performance.now();
      store.dispatch('seek', { time });
      await settled((s) => !s.seeking && Math.abs(s.currentTime - time) < 1e-6);
      return performance.now() - t0;
    },
    state: () => store.getState(),
  };
}

window.wc = start();
