// Runs core inside a module Worker: core must be DOM-free (SPEC §1.1).

import { createCore, type StoreSlice } from '@otter-player/core';

const playback: StoreSlice<{ paused: boolean }> = { id: 'playback', initialState: { paused: true } };
const core = createCore<{ paused: boolean }, { play: undefined }>({ slices: [playback] });
core.store.handle('play', (_p, ctx) => ctx.setState({ paused: false }));
core.store.dispatch('play', undefined);

postMessage({ paused: core.store.getState().paused, hasDocument: 'document' in globalThis });
