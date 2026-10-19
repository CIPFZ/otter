// Player fixture: the M1 composition a host (or a future preset) would build, exposed on
// window.otter so the e2e scenario matrix can drive it. Engine and UI only meet in the store.

import { createCore, type QoeEventMap, type RouteExplanation } from '@otter-player/core';
import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createWebCodecsBackendFactory } from '@otter-player/backend-webcodecs';
import { createDashFormat } from '@otter-player/format-dash';
import { createFlvFormat } from '@otter-player/format-flv';
import { createHlsFormat } from '@otter-player/format-hls';
import { createMp4RangeFormat } from '@otter-player/format-mp4-range';
import { createTsFormat } from '@otter-player/format-ts';
import {
  createMediaPlugin,
  MEDIA_SLICE,
  type LoadOptions,
  type MediaActionMap,
  type MediaState,
  type RoutePolicy,
  type Source,
} from '@otter-player/media';
import { createQoePlugin, QOE_SLICE, type QoeState } from '@otter-player/qoe';
import { createVideoSurface } from '@otter-player/surface';
import { defineOtterElements, provideStore } from '@otter-player/ui-core';

type State = MediaState & QoeState;

export interface OtterFixture {
  load(source: Source, options?: LoadOptions): void;
  dispatch<K extends keyof MediaActionMap>(type: K, payload: MediaActionMap[K]): boolean;
  state(): State;
  explain(): RouteExplanation | null;
  readonly events: { type: keyof QoeEventMap; payload: unknown }[];
  /** Blob of a same-origin URL, for the local-file scenario. */
  fetchBlob(url: string): Promise<Blob>;
  setPolicy(policy: RoutePolicy): Promise<void>;
}

declare global {
  interface Window {
    otter?: Promise<OtterFixture>;
  }
}

const QOE_TYPES: readonly (keyof QoeEventMap)[] = [
  'startup',
  'rebuffer',
  'quality-switch',
  'error',
  'bandwidth',
  'latency',
  'dropped-frames',
  'exit',
  'route',
];

async function build(policy: RoutePolicy): Promise<{
  core: ReturnType<typeof createCore<State, MediaActionMap>>;
  media: ReturnType<typeof createMediaPlugin<State, MediaActionMap>>;
}> {
  const abr = new URLSearchParams(location.search).get('abr') === 'engine' ? 'engine' : 'otter';
  const root = document.getElementById('player') as HTMLElement;
  const video = root.querySelector('video') as HTMLVideoElement;
  createVideoSurface(video);
  const media = createMediaPlugin<State, MediaActionMap>({
    target: video,
    // ?abr=engine: the engines' own ABR instead of the Otter rule stack, for A/B runs (ADR-005 §1).
    formats: [createHlsFormat({ abr }), createDashFormat({ abr }), createFlvFormat(), createTsFormat(), createMp4RangeFormat()],
    backends: [createMseBackendFactory(), createNativeBackendFactory(), createWebCodecsBackendFactory()],
    policy,
  });
  const core = createCore<State, MediaActionMap>({ slices: [MEDIA_SLICE, QOE_SLICE], plugins: [media, createQoePlugin()] });
  await core.start();
  provideStore(root, core.store.view());
  return { core, media };
}

async function start(): Promise<OtterFixture> {
  defineOtterElements();
  const events: OtterFixture['events'] = [];
  let current = await build({});
  const listen = (): void => {
    for (const type of QOE_TYPES) current.core.qoe.on(type, (payload) => events.push({ type, payload }));
  };
  listen();

  const toggle = document.getElementById('toggle-stats') as HTMLInputElement;
  const stats = document.querySelector('otter-stats') as HTMLElement;
  toggle.addEventListener('change', () => {
    stats.hidden = !toggle.checked;
  });

  return {
    load: (source, options = {}) => {
      current.core.store.dispatch('load', { source, options });
    },
    dispatch: (type, payload) => current.core.store.dispatch(type, payload),
    state: () => current.core.store.getState(),
    explain: () => current.media.router.explain(),
    events,
    fetchBlob: async (url) => (await fetch(url)).blob(),
    async setPolicy(policy) {
      await current.core.destroy();
      current = await build(policy);
      listen();
    },
  };
}

window.otter = start();
