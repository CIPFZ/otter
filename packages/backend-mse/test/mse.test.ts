// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus, createQoeHook } from '@otter-player/core';
import {
  airPlayAlternate,
  createMseBackend,
  finishRemotePlayback,
  prepareRemotePlayback,
  useManagedMediaSource,
} from '@otter-player/backend-mse';
import {
  EMPTY_TRACKS,
  NO_CAPABILITIES,
  type BackendEvents,
  type Engine,
  type EngineContext,
  type EngineEvents,
  type FormatPlugin,
} from '@otter-player/media';

afterEach(() => vi.unstubAllGlobals());

const MMS = class {};
const MS = class {};

describe('MMS decision (vendored hls.js getMediaSource)', () => {
  it('uses MMS when preferred, or when MediaSource is missing (iPhone)', () => {
    vi.stubGlobal('ManagedMediaSource', MMS);
    vi.stubGlobal('MediaSource', MS);
    expect(useManagedMediaSource(true)).toBe(true);
    expect(useManagedMediaSource(false)).toBe(false);
    vi.stubGlobal('MediaSource', undefined);
    expect(useManagedMediaSource(false)).toBe(true);
    vi.stubGlobal('ManagedMediaSource', undefined);
    vi.stubGlobal('MediaSource', MS);
    expect(useManagedMediaSource(true)).toBe(false);
  });

  it('finds the AirPlay alternate', () => {
    expect(airPlayAlternate({ src: 'https://e.test/a.mpd', airplaySrc: 'https://e.test/a.m3u8' })).toBe('https://e.test/a.m3u8');
    expect(airPlayAlternate({ src: 'https://e.test/a.m3u8?t=1' })).toBe('https://e.test/a.m3u8?t=1');
    expect(airPlayAlternate({ src: 'https://e.test/live', type: 'application/vnd.apple.mpegurl' })).toBe('https://e.test/live');
    expect(airPlayAlternate({ src: 'https://e.test/a.mpd' })).toBeUndefined();
  });
});

describe('remote playback preconditions', () => {
  it('without an alternate, MMS needs disableRemotePlayback before attach', () => {
    const video = document.createElement('video');
    prepareRemotePlayback(video, true, undefined);
    expect(video.disableRemotePlayback).toBe(true);
    const plain = document.createElement('video');
    prepareRemotePlayback(plain, true, 'https://e.test/a.m3u8');
    prepareRemotePlayback(plain, false, undefined);
    expect(plain.disableRemotePlayback).toBe(false);
  });

  it('after an engine stripped sources and forced disableRemotePlayback, the alternate is restored', () => {
    const video = document.createElement('video');
    // What hls.js does on attach under MMS:
    video.appendChild(Object.assign(document.createElement('source'), { src: 'blob:mms', type: 'video/mp4' }));
    video.disableRemotePlayback = true;
    const result = finishRemotePlayback(video, true, 'https://e.test/a.m3u8');
    const sources = Array.from(video.querySelectorAll('source'));
    expect(sources.map((s) => s.getAttribute('src'))).toEqual(['blob:mms', 'https://e.test/a.m3u8']);
    expect(sources[1]?.type).toBe('application/vnd.apple.mpegurl');
    expect(video.disableRemotePlayback).toBe(false);
    expect(result).toMatchObject({ remotePlayback: 'enabled', reason: 'mms: AirPlay alternate source' });
  });

  it('reuses an alternate the engine added itself (Shaka for HLS)', () => {
    const video = document.createElement('video');
    video.appendChild(Object.assign(document.createElement('source'), { src: 'https://e.test/a.m3u8', type: 'application/x-mpegurl' }));
    const result = finishRemotePlayback(video, true, 'https://e.test/a.m3u8');
    expect(video.querySelectorAll('source')).toHaveLength(1);
    expect(result.added).toBeUndefined();
  });

  it('leaves MSE playback untouched', () => {
    const video = document.createElement('video');
    expect(finishRemotePlayback(video, false, 'https://e.test/a.m3u8')).toMatchObject({ remotePlayback: 'enabled', added: undefined });
  });
});

describe('createMseBackend', () => {
  function fakeEngine(ctx: EngineContext, behavior: { mms: boolean; strip: boolean }): Engine & { emit: <E extends keyof EngineEvents>(e: E, p: EngineEvents[E]) => void; destroyed: boolean } {
    const bus = createEventBus<EngineEvents>();
    const engine = {
      formatId: 'hls',
      tracks: { ...EMPTY_TRACKS, quality: 'selectable' as const },
      mms: behavior.mms,
      destroyed: false,
      load: async () => {
        if (behavior.strip) {
          ctx.media.appendChild(Object.assign(document.createElement('source'), { src: 'blob:mms' }));
          ctx.media.disableRemotePlayback = true;
        }
      },
      selectQuality: vi.fn(),
      on: (e: keyof EngineEvents, h: (p: never) => void) => bus.on(e, (p) => h(p as never)),
      emit: <E extends keyof EngineEvents>(e: E, p: EngineEvents[E]) => bus.emit(e, p),
      destroy() {
        engine.destroyed = true;
      },
    };
    return engine;
  }

  it('hosts the engine, reports MMS handling and forwards engine events', async () => {
    vi.stubGlobal('ManagedMediaSource', MMS);
    vi.stubGlobal('MediaSource', undefined);
    let engine: ReturnType<typeof fakeEngine> | undefined;
    let seenCtx: EngineContext | undefined;
    const format: FormatPlugin = {
      id: 'hls',
      probe: () => 1,
      backends: () => ['mse'],
      createEngine: (ctx) => {
        seenCtx = ctx;
        engine = fakeEngine(ctx, { mms: true, strip: true });
        return engine;
      },
    };
    const backend = createMseBackend({ format, step: { backend: 'mse' }, caps: NO_CAPABILITIES, qoe: createQoeHook() }, { allowCodecSwitch: true });
    const events: [keyof BackendEvents, unknown][] = [];
    for (const e of ['remote-playback', 'quality-change', 'error', 'tracks-change'] as const) {
      backend.on(e, (p) => events.push([e, p]));
    }
    const video = document.createElement('video');
    backend.attach(video);
    await backend.load({ src: 'https://e.test/a.m3u8' }, {});

    expect(seenCtx).toMatchObject({ backend: 'mse', mms: true, allowCodecSwitch: true, media: video });
    expect(events).toContainEqual(['remote-playback', { mms: true, remotePlayback: 'enabled', reason: 'mms: AirPlay alternate source' }]);
    expect(video.disableRemotePlayback).toBe(false);

    engine?.emit('quality-change', { id: 'level-1', auto: true, reason: 'abr' });
    expect(events).toContainEqual(['quality-change', { id: 'level-1', auto: true, reason: 'abr' }]);
    backend.selectQuality('level-0');
    expect(engine?.selectQuality).toHaveBeenCalledWith('level-0');

    backend.destroy();
    expect(engine?.destroyed).toBe(true);
    expect(video.querySelectorAll('source')).toHaveLength(0);
  });
});
