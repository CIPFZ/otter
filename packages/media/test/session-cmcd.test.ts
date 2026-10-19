import { describe, expect, it, vi } from 'vitest';
import { createCore } from '@otter-player/core';
import {
  createMediaPlugin,
  EMPTY_TIME_RANGES,
  EMPTY_TRACKS,
  MEDIA_SLICE,
  NO_CAPABILITIES,
  type BackendContext,
  type FormatPlugin,
  type MediaActionMap,
  type MediaBackend,
  type MediaState,
} from '@otter-player/media';

const fmt: FormatPlugin = { id: 'hls', probe: () => 1, backends: () => ['mse'], createEngine: () => { throw new Error('unused'); } };

function backend(): MediaBackend {
  return {
    kind: 'mse', tracks: EMPTY_TRACKS, buffered: EMPTY_TIME_RANGES,
    attach: () => undefined, load: async () => undefined, play: async () => undefined, pause: () => undefined,
    seek: () => undefined, setVolume: () => undefined, setMuted: () => undefined, setPlaybackRate: () => undefined,
    selectQuality: () => undefined, on: () => () => undefined, destroy: () => undefined,
  };
}

async function run(cmcd: { enabled: boolean } | undefined) {
  const seen: BackendContext[] = [];
  const plugin = createMediaPlugin({
    target: {} as HTMLMediaElement,
    formats: [fmt],
    backends: [{ kind: 'mse', create: (ctx) => (seen.push(ctx), backend()) }],
    detect: async () => ({ ...NO_CAPABILITIES, mediaSource: true }),
    ...(cmcd === undefined ? {} : { cmcd }),
  });
  const core = createCore<MediaState, MediaActionMap>({ slices: [MEDIA_SLICE], plugins: [plugin] });
  const errors: string[] = [];
  core.qoe.on('error', ({ error }) => errors.push(error.details));
  await core.start();
  core.store.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
  await vi.waitFor(() => expect(core.store.getState().status).toBe('ready'));
  return { seen, errors };
}

describe('session CMCD', () => {
  it('is off by default', async () => {
    const { seen } = await run(undefined);
    expect(seen[0]?.cmcd).toBeUndefined();
  });

  it('hands one decorator per load to the backend, with a live view of session state', async () => {
    const { seen } = await run({ enabled: true });
    const cmcd = seen[0]?.cmcd;
    expect(cmcd?.mode).toBe('query');
    const url = new URL(cmcd?.decorate({ url: 'https://e.test/1.ts', kind: 'video' }).url ?? '');
    expect(url.searchParams.get('CMCD')).toMatch(/sf=h,sid="[0-9a-f-]{36}",st=v,su/);
  });
});
