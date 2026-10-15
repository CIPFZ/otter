// Fixture app: wires the real packages in a real browser and reports results to the tests
// through `window.__otter`.

import { createCore, type StoreSlice } from '@otter-player/core';
import { DEFAULT_HOTKEYS } from '@otter-player/input';
import { NO_CAPABILITIES } from '@otter-player/media';
import { createVideoSurface } from '@otter-player/surface';

interface FixtureState {
  paused: boolean;
}
interface FixtureActions {
  play: undefined;
}

export interface FixtureResult {
  readonly mainThread: { readonly paused: boolean; readonly hotkeys: number; readonly surfaceKind: string };
  readonly worker: { readonly paused: boolean; readonly hasDocument: boolean } | { readonly error: string };
  readonly capabilities: boolean;
}

declare global {
  interface Window {
    __otter?: Promise<FixtureResult>;
  }
}

const playback: StoreSlice<FixtureState> = { id: 'playback', initialState: { paused: true } };

const runInWorker = (): Promise<FixtureResult['worker']> =>
  new Promise((resolve) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FixtureResult['worker']>) => {
      resolve(e.data);
      worker.terminate();
    };
    worker.onerror = (e) => {
      resolve({ error: e.message });
      worker.terminate();
    };
  });

async function run(): Promise<FixtureResult> {
  const core = createCore<FixtureState, FixtureActions>({ slices: [playback] });
  core.store.handle('play', (_p, ctx) => ctx.setState({ paused: false }));
  await core.start();
  core.store.view().dispatch('play', undefined, { type: 'click' });
  const surface = createVideoSurface(document.createElement('video'));

  const result: FixtureResult = {
    mainThread: {
      paused: core.store.getState().paused,
      hotkeys: Object.keys(DEFAULT_HOTKEYS).length,
      surfaceKind: surface.kind,
    },
    worker: await runInWorker(),
    capabilities: NO_CAPABILITIES.mediaSource === false,
  };
  const status = document.getElementById('status');
  if (status !== null) status.textContent = 'Ready';
  return result;
}

window.__otter = run();
