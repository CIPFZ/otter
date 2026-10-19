import { expect, it, vi } from 'vitest';

// The encoder failing to load must not stop playback; it is reported as a non-fatal QoE error.
vi.mock('@svta/cml-cmcd', () => {
  throw new Error('blocked by CSP');
});

const { createCore } = await import('@otter-player/core');
const { createMediaPlugin, EMPTY_TIME_RANGES, EMPTY_TRACKS, MEDIA_SLICE, NO_CAPABILITIES } = await import('@otter-player/media');

it('plays on without CMCD when the encoder cannot load', async () => {
  const contexts: { cmcd?: unknown }[] = [];
  const plugin = createMediaPlugin({
    target: {} as HTMLMediaElement,
    formats: [{ id: 'hls', probe: () => 1, backends: () => ['mse'], createEngine: () => { throw new Error('unused'); } }],
    backends: [{
      kind: 'mse',
      create: (ctx) => {
        contexts.push(ctx);
        return {
          kind: 'mse', tracks: EMPTY_TRACKS, buffered: EMPTY_TIME_RANGES,
          attach: () => undefined, load: async () => undefined, play: async () => undefined, pause: () => undefined,
          seek: () => undefined, setVolume: () => undefined, setMuted: () => undefined, setPlaybackRate: () => undefined,
          selectQuality: () => undefined, on: () => () => undefined, destroy: () => undefined,
        };
      },
    }],
    detect: async () => ({ ...NO_CAPABILITIES, mediaSource: true }),
    cmcd: { enabled: true },
  });
  const core = createCore({ slices: [MEDIA_SLICE], plugins: [plugin] });
  const errors: string[] = [];
  core.qoe.on('error', ({ error }) => errors.push(`${error.details}:${error.fatal}`));
  await core.start();
  core.store.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
  await vi.waitFor(() => expect(core.store.getState().status).toBe('ready'));
  expect(contexts[0]?.cmcd).toBeUndefined();
  expect(errors).toEqual(['cmcdUnavailable:false']);
});
