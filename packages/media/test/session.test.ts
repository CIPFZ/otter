import { describe, expect, it, vi } from 'vitest';
import { createCore, createError, type QoeEventMap } from '@otter-player/core';
import {
  createMediaPlugin,
  EMPTY_TIME_RANGES,
  type RecoveryPolicy,
  EMPTY_TRACKS,
  MEDIA_SLICE,
  NO_CAPABILITIES,
  type BackendEvents,
  type BackendFactory,
  type BackendKind,
  type FormatPlugin,
  type MediaActionMap,
  type MediaBackend,
  type MediaState,
} from '@otter-player/media';

type Listener = (p: unknown) => void;

interface FakeBackend extends MediaBackend {
  emit<E extends keyof BackendEvents>(e: E, p: BackendEvents[E]): void;
  readonly calls: string[];
}

function fakeBackend(kind: BackendKind, behavior: { failLoad?: boolean } = {}): FakeBackend {
  const listeners = new Map<string, Set<Listener>>();
  const calls: string[] = [];
  return {
    kind,
    calls,
    tracks: { ...EMPTY_TRACKS, quality: 'selectable', video: [{ kind: 'video', id: 'v1', selected: true, codec: 'avc1.42E01E' }] },
    buffered: EMPTY_TIME_RANGES,
    attach: () => calls.push('attach'),
    load: async () => {
      calls.push('load');
      if (behavior.failLoad === true) {
        throw createError({ type: 'media', details: 'mediaSrcNotSupported', fatal: true, recoverable: false });
      }
    },
    play: () => {
      calls.push('play');
      return Promise.resolve();
    },
    pause: () => calls.push('pause'),
    seek: (t) => calls.push(`seek:${t}`),
    setVolume: (v) => calls.push(`volume:${v}`),
    setMuted: (m) => calls.push(`muted:${m}`),
    setPlaybackRate: (r) => calls.push(`rate:${r}`),
    selectQuality: (id) => calls.push(`quality:${id}`),
    selectTextTrack: (id) => calls.push(`text:${id}`),
    on(e, h) {
      let set = listeners.get(e);
      if (set === undefined) listeners.set(e, (set = new Set()));
      set.add(h as Listener);
      return () => set.delete(h as Listener);
    },
    emit(e, p) {
      for (const h of listeners.get(e) ?? []) h(p);
    },
    destroy: () => calls.push('destroy'),
  };
}

const hls: FormatPlugin = {
  id: 'hls',
  probe: () => 1,
  backends: () => ['mse', 'native'],
  createEngine: () => {
    throw new Error('unused');
  },
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const target = {} as HTMLMediaElement;

// No backoff by default so `flush()` covers a retry; stall watchdog off unless a test enables it.
async function setup(
  behavior: Partial<Record<BackendKind, { failLoad?: boolean }>> = {},
  recovery: Partial<RecoveryPolicy> = { backoffMs: () => 0, stallTimeoutMs: 0 },
) {
  const created: FakeBackend[] = [];
  const factory = (kind: BackendKind): BackendFactory => ({
    kind,
    create: () => {
      const b = fakeBackend(kind, behavior[kind]);
      created.push(b);
      return b;
    },
  });
  let clock = 1000;
  const plugin = createMediaPlugin({
    target,
    formats: [hls],
    backends: [factory('mse'), factory('native')],
    detect: async () => ({ ...NO_CAPABILITIES, mediaSource: true }),
    now: () => clock,
    recovery,
  });
  const core = createCore<MediaState, MediaActionMap>({ slices: [MEDIA_SLICE], plugins: [plugin] });
  const qoe: { type: keyof QoeEventMap; payload: unknown }[] = [];
  for (const type of ['startup', 'rebuffer', 'quality-switch', 'error', 'bandwidth', 'exit', 'route'] as const) {
    core.qoe.on(type, (payload) => qoe.push({ type, payload }));
  }
  await core.start();
  const view = core.store.view();
  return { core, view, plugin, created, qoe, tick: (ms: number) => (clock += ms) };
}

describe('media plugin', () => {
  it('loads through the router and publishes the route', async () => {
    const { view, created, qoe, plugin } = await setup();
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    expect(view.getState().status).toBe('loading');
    await flush();
    expect(view.getState()).toMatchObject({ status: 'ready', backend: 'mse', format: 'hls' });
    // Preferences reach the element before load (muted autoplay, no store overwrite during load).
    expect(created[0]?.calls.slice(0, 5)).toEqual(['attach', 'volume:1', 'muted:false', 'rate:1', 'load']);
    expect(view.getState().route).toEqual(plugin.router.explain());
    expect(qoe.find((e) => e.type === 'route')?.payload).toMatchObject({ backend: 'mse' });
  });

  it('falls back to the next backend when load fails and reports the remaining path', async () => {
    const { view, created, qoe } = await setup({ mse: { failLoad: true } });
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    expect(view.getState()).toMatchObject({ status: 'ready', backend: 'native' });
    expect(created.map((b) => b.kind)).toEqual(['mse', 'native']);
    expect(created[0]?.calls).toContain('destroy');
    expect(qoe.find((e) => e.type === 'error')?.payload).toMatchObject({
      error: { details: 'mediaSrcNotSupported' },
      fallback: ['native'],
    });
    const steps = view.getState().route?.steps ?? [];
    expect(steps.filter((s) => s.outcome !== 'rejected').map((s) => `${s.candidate}:${s.outcome}`)).toEqual([
      'format:hls:selected',
      'platform:selected',
      'mse:selected',
      'mse:failed',
      'native:selected',
    ]);
  });

  it('ends in error when the chain is exhausted', async () => {
    const { view, qoe } = await setup({ mse: { failLoad: true }, native: { failLoad: true } });
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    expect(view.getState()).toMatchObject({ status: 'error', error: { details: 'mediaSrcNotSupported' } });
    expect(qoe.filter((e) => e.type === 'error').at(-1)?.payload).toMatchObject({ fallback: [] });
  });

  it('recovers from a fatal backend error after load: same backend once, then the fallback chain', async () => {
    const { view, created, qoe } = await setup();
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    created[0]?.emit('playback-change', { currentTime: 42 });
    created[0]?.emit('error', createError({ type: 'media', details: 'bufferAppendError', fatal: true, recoverable: false }));
    await flush();
    expect(created.map((b) => b.kind)).toEqual(['mse', 'mse']);
    expect(view.getState()).toMatchObject({ status: 'ready', backend: 'mse' });
    expect(created[1]?.calls).toContain('load');
    expect(qoe.filter((e) => e.type === 'error').at(-1)?.payload).toMatchObject({ fallback: ['mse', 'native'] });
    // Media budget (1) spent: the next fatal error moves down the chain.
    created[1]?.emit('error', createError({ type: 'media', details: 'bufferAppendError', fatal: true, recoverable: false }));
    await flush();
    expect(created.map((b) => b.kind)).toEqual(['mse', 'mse', 'native']);
    expect(view.getState().backend).toBe('native');
  });

  it('forwards in-band cues and re-applies the text track to a rebuilt backend', async () => {
    const { view, created, plugin } = await setup();
    const got: string[] = [];
    plugin.onTextCues(({ trackId, cues }) => got.push(`${trackId}:${cues.length}`));
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    view.dispatch('set-text-track', { id: 'text-0' });
    expect(created[0]?.calls).toContain('text:text-0');
    created[0]?.emit('text-cues', { trackId: 'text-0', cues: [{ id: 'a', startTime: 0, endTime: 1, text: 'x' }] });
    expect(got).toEqual(['text-0:1']);
    created[0]?.emit('error', createError({ type: 'media', details: 'bufferAppendError', fatal: true, recoverable: false }));
    await flush();
    expect(created[1]?.calls).toContain('text:text-0');
  });

  it('skips the retry for errors a rebuild cannot fix', async () => {
    const { view, created } = await setup();
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    created[0]?.emit('error', createError({ type: 'media', details: 'mediaSrcNotSupported', fatal: true, recoverable: false }));
    await flush();
    expect(created.map((b) => b.kind)).toEqual(['mse', 'native']);
  });

  it('dispatches play synchronously (user activation) and maps input actions', async () => {
    const { view, created } = await setup();
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    const b = created[0] as FakeBackend;
    view.dispatch('toggle-paused', {});
    expect(b.calls.at(-1)).toBe('play');
    b.emit('playback-change', { paused: false, duration: 100, currentTime: 10 });
    view.dispatch('toggle-paused', {});
    expect(b.calls.at(-1)).toBe('pause');
    view.dispatch('seek-by', { seconds: 10 });
    view.dispatch('seek-to-percent', { percent: 50 });
    view.dispatch('seek', { time: 1000 });
    view.dispatch('volume-by', { delta: -0.25 });
    view.dispatch('toggle-muted', {});
    view.dispatch('hold-rate', { rate: 2 });
    view.dispatch('hold-rate', { rate: 0 });
    view.dispatch('select-quality', { id: 'v1' });
    expect(b.calls.slice(-8)).toEqual(['seek:20', 'seek:50', 'seek:100', 'volume:0.75', 'muted:true', 'rate:2', 'rate:1', 'quality:v1']);
    expect(view.getState()).toMatchObject({ volume: 0.75, muted: true, playbackRate: 1, quality: 'v1' });
  });

  it('emits startup, rebuffer, quality-switch and exit QoE events', async () => {
    const { view, created, qoe, tick } = await setup();
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    const b = created[0] as FakeBackend;
    b.emit('quality-change', { id: 'v1', auto: true, reason: 'abr' });
    b.emit('quality-change', { id: 'v2', auto: true, reason: 'abr' });
    tick(250);
    b.emit('first-frame', { at: 1250 });
    b.emit('playback-change', { paused: false, readyState: 4, currentTime: 1 });
    b.emit('playback-change', { currentTime: 2 });
    b.emit('playback-change', { waiting: true });
    tick(400);
    b.emit('playback-change', { waiting: false });
    view.dispatch('unload', undefined);
    const byType = Object.fromEntries(qoe.map((e) => [e.type, e.payload]));
    expect(byType['startup']).toEqual({ ttff: 250, backend: 'mse', format: 'hls' });
    // Initial selection (null -> v1) is not a switch; v1 -> v2 is.
    expect(qoe.filter((e) => e.type === 'quality-switch').map((e) => e.payload)).toEqual([{ from: 'v1', to: 'v2', reason: 'abr', mode: 'auto' }]);
    expect(byType['rebuffer']).toMatchObject({ position: 2, duration: 400 });
    expect(byType['exit']).toEqual({ position: 2, watched: 1 });
    expect(b.calls).toContain('destroy');
    expect(view.getState().status).toBe('idle');
  });

  it('takes the initial quality from the track list without counting a switch', async () => {
    const { view, created, qoe } = await setup();
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    const b = created[0] as FakeBackend;
    b.emit('tracks-change', { ...b.tracks });
    expect(view.getState().activeQuality).toBe('v1');
    expect(qoe.some((e) => e.type === 'quality-switch')).toBe(false);
  });

  it('applies a mute chosen before load to the element before loading (muted autoplay)', async () => {
    const { view, created } = await setup();
    view.dispatch('set-muted', { muted: true });
    view.dispatch('set-playback-rate', { rate: 1.5 });
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' }, options: { autoplay: true } });
    await flush();
    const calls = created[0]?.calls ?? [];
    expect(calls.indexOf('muted:true')).toBeLessThan(calls.indexOf('load'));
    expect(calls.indexOf('rate:1.5')).toBeLessThan(calls.indexOf('load'));
    expect(calls.indexOf('load')).toBeLessThan(calls.indexOf('play'));
  });

  it('ignores events from a superseded load', async () => {
    const { view, created } = await setup();
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    view.dispatch('load', { source: { src: 'https://e.test/b.m3u8' } });
    await flush();
    created[0]?.emit('playback-change', { currentTime: 99 });
    expect(view.getState().currentTime).toBe(0);
    expect(view.getState().source?.src).toBe('https://e.test/b.m3u8');
  });

  it('ignores AbortError from interrupted play() and never masks a fatal error', async () => {
    const { view, created } = await setup({ native: { failLoad: true } }, { retries: { media: 0 }, stallTimeoutMs: 0 });
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    const b = created[0] as FakeBackend;
    b.play = vi.fn(() => Promise.reject(Object.assign(new Error('interrupted'), { name: 'AbortError' })));
    view.dispatch('play', undefined);
    await flush();
    expect(view.getState().error).toBeNull();
    b.play = vi.fn(() => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })));
    view.dispatch('play', undefined);
    b.emit('error', createError({ type: 'media', details: 'mediaDecodeError', fatal: true, recoverable: false }));
    await flush();
    expect(view.getState()).toMatchObject({ status: 'error', error: { details: 'mediaSrcNotSupported' } });
  });

  it('surfaces autoplay rejections as non-fatal errors', async () => {
    const { view, created } = await setup();
    view.dispatch('load', { source: { src: 'https://e.test/a.m3u8' } });
    await flush();
    const b = created[0] as FakeBackend;
    b.play = vi.fn(() => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })));
    view.dispatch('play', undefined);
    await flush();
    expect(view.getState().error).toMatchObject({ details: 'playNotAllowed', fatal: false });
  });
});

describe('fallback source (Source.fallback)', () => {
  const whep: FormatPlugin = {
    id: 'whep',
    probe: (s) => (String(s.src).includes('/whep') ? 1 : 0),
    backends: () => ['native'],
    createEngine: () => {
      throw new Error('unused');
    },
  };
  const m3u8: FormatPlugin = { ...hls, probe: (s) => (String(s.src).endsWith('.m3u8') ? 1 : 0) };

  async function setupSources() {
    const created: { kind: BackendKind; src: string }[] = [];
    const factory = (kind: BackendKind): BackendFactory => ({
      kind,
      create: () => {
        const b = fakeBackend(kind);
        return {
          ...b,
          load: async (source) => {
            created.push({ kind, src: String(source.src) });
            // WebRTC cannot connect here: a fatal iceFailed, which is not retried.
            if (String(source.src).includes('/whep')) throw createError({ type: 'network', details: 'iceFailed', fatal: true, recoverable: false });
          },
        };
      },
    });
    const plugin = createMediaPlugin({
      target,
      formats: [whep, m3u8],
      backends: [factory('mse'), factory('native')],
      detect: async () => ({ ...NO_CAPABILITIES, mediaSource: true }),
      recovery: { backoffMs: () => 0, stallTimeoutMs: 0 },
    });
    const core = createCore<MediaState, MediaActionMap>({ slices: [MEDIA_SLICE], plugins: [plugin] });
    const errors: unknown[] = [];
    core.qoe.on('error', (p) => void errors.push(p));
    await core.start();
    return { view: core.store.view(), created, errors };
  }

  it('routes the fallback source afresh once every backend for the source failed', async () => {
    const { view, created, errors } = await setupSources();
    const fallback = { src: 'https://e.test/live.m3u8', live: true };
    view.dispatch('load', { source: { src: 'https://e.test/whep/live', live: true, fallback } });
    await flush();
    await flush();
    // One WHEP attempt (iceFailed is not retried), then HLS over MSE.
    expect(created).toEqual([
      { kind: 'native', src: 'https://e.test/whep/live' },
      { kind: 'mse', src: 'https://e.test/live.m3u8' },
    ]);
    expect(view.getState()).toMatchObject({ status: 'ready', format: 'hls', backend: 'mse', source: fallback });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ error: { details: 'iceFailed' }, fallback: [] });
    expect(view.getState().route?.steps.some((s) => s.candidate === 'source fallback' && s.outcome === 'selected' && s.reason === 'format hls')).toBe(true);
  });

  it('ends in error without a fallback source', async () => {
    const { view, created } = await setupSources();
    view.dispatch('load', { source: { src: 'https://e.test/whep/live', live: true } });
    await flush();
    expect(created).toHaveLength(1);
    expect(view.getState()).toMatchObject({ status: 'error', error: { details: 'iceFailed' } });
  });
});
