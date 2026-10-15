import { describe, expect, it, vi } from 'vitest';
import { createQoeHook } from '@otter-player/core';
import { NO_CAPABILITIES, type EngineContext, type EngineEvents } from '@otter-player/media';

type Handler = (event: string, data: Record<string, unknown>) => void;

// Minimal stand-in for hls.js: records calls and lets the test fire hls.js events.
class FakeHls {
  static instances: FakeHls[] = [];
  static supported = true;
  static isSupported = (): boolean => FakeHls.supported;
  static Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    ERROR: 'hlsError',
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
    SUBTITLE_TRACKS_UPDATED: 'hlsSubtitleTracksUpdated',
    FRAG_LOADED: 'hlsFragLoaded',
    FRAG_BUFFERED: 'hlsFragBuffered',
  };
  handlers = new Map<string, Handler[]>();
  calls: string[] = [];
  levels = [
    { bitrate: 500_000, width: 640, height: 360, frameRate: 30, videoCodec: 'avc1.4d401e', name: '' },
    { bitrate: 2_000_000, width: 1280, height: 720, frameRate: 30, videoCodec: 'avc1.4d401f', name: '720p' },
  ];
  currentLevel = 0;
  autoLevelEnabled = true;
  audioTracks: unknown[] = [];
  audioTrack = -1;
  subtitleTracks = [{ id: 0, name: 'English', lang: 'en', type: 'SUBTITLES' }];
  subtitleTrack = -1;
  bandwidthEstimate = 3_000_000;
  latency = 0;
  latestLevelDetails: { live: boolean } | null = { live: false };
  targetLatency: number | null = null;
  nextLevel = -1;
  config: Record<string, unknown>;
  constructor(config: Record<string, unknown>) {
    this.config = config;
    FakeHls.instances.push(this);
  }
  on(event: string, h: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), h]);
  }
  fire(event: string, data: Record<string, unknown> = {}): void {
    for (const h of this.handlers.get(event) ?? []) h(event, data);
  }
  loadSource(url: string): void {
    this.calls.push(`loadSource:${url}`);
  }
  attachMedia(): void {
    this.calls.push('attachMedia');
  }
  recoverMediaError(): void {
    this.calls.push('recoverMediaError');
  }
  destroy(): void {
    this.calls.push('destroy');
  }
}

vi.mock('hls.js', () => ({ default: FakeHls }));

const { createHlsJsEngine, mapHlsError } = await import('@otter-player/engine-adapter-hlsjs');

const ctx = (overrides: Partial<EngineContext> = {}): EngineContext => ({
  source: { src: 'https://e.test/a.m3u8' },
  options: { startTime: 12 },
  caps: NO_CAPABILITIES,
  backend: 'mse',
  qoe: createQoeHook(),
  media: {} as HTMLMediaElement,
  mms: true,
  allowCodecSwitch: false,
  ...overrides,
});

async function loaded() {
  const engine = createHlsJsEngine(ctx());
  const events: [keyof EngineEvents, unknown][] = [];
  for (const e of ['tracks-change', 'quality-change', 'first-segment', 'bandwidth', 'latency-change', 'error'] as const) {
    engine.on(e, (p) => events.push([e, p]));
  }
  const before = FakeHls.instances.length;
  const loading = engine.load();
  await vi.waitFor(() => expect(FakeHls.instances.length).toBeGreaterThan(before));
  const hls = FakeHls.instances.at(-1) as FakeHls;
  hls.fire(FakeHls.Events.MANIFEST_PARSED);
  await loading;
  return { engine, hls, events };
}

describe('hls.js adapter', () => {
  it('configures hls.js from the context and maps levels to tracks', async () => {
    const { engine, hls } = await loaded();
    expect(hls.config).toMatchObject({ preferManagedMediaSource: true, startPosition: 12 });
    expect(hls.calls).toEqual(['loadSource:https://e.test/a.m3u8', 'attachMedia']);
    expect(engine.tracks).toMatchObject({
      quality: 'selectable',
      requestedQuality: 'auto',
      video: [
        { id: 'level-0', width: 640, height: 360, bitrate: 500_000, codec: 'avc1.4d401e', selected: true },
        { id: 'level-1', label: '720p', selected: false },
      ],
      text: [{ id: 'text-0', language: 'en', label: 'English', role: 'subtitles' }],
    });
  });

  it('emits quality, first-segment and bandwidth events, selects levels', async () => {
    const { engine, hls, events } = await loaded();
    hls.fire(FakeHls.Events.LEVEL_SWITCHED, { level: 1 });
    hls.fire(FakeHls.Events.FRAG_LOADED, { frag: { type: 'main' } });
    hls.fire(FakeHls.Events.FRAG_LOADED, { frag: { type: 'main' } });
    hls.fire(FakeHls.Events.FRAG_BUFFERED, { frag: { type: 'main' } });
    expect(events).toContainEqual(['quality-change', { id: 'level-1', auto: true, reason: 'abr' }]);
    expect(events.filter(([e]) => e === 'first-segment')).toHaveLength(1);
    expect(events).toContainEqual(['bandwidth', { estimate: 3_000_000, fast: 3_000_000, slow: 3_000_000 }]);
    engine.selectQuality('level-1');
    expect(hls.nextLevel).toBe(1);
    engine.selectQuality('auto');
    expect(hls.nextLevel).toBe(-1);
  });

  it('tries recoverMediaError once before a fatal media error escalates', async () => {
    const { hls, events } = await loaded();
    const fatal = { type: 'mediaError', details: 'bufferAppendError', fatal: true, error: new Error('x') };
    hls.fire(FakeHls.Events.ERROR, fatal);
    hls.fire(FakeHls.Events.ERROR, fatal);
    expect(hls.calls.filter((c) => c === 'recoverMediaError')).toHaveLength(1);
    expect(events.filter(([e]) => e === 'error').map(([, p]) => (p as { fatal: boolean }).fatal)).toEqual([false, true]);
  });

  it('rejects load on a fatal manifest error and on unsupported environments', async () => {
    const engine = createHlsJsEngine(ctx());
    const before = FakeHls.instances.length;
    const loading = engine.load();
    await vi.waitFor(() => expect(FakeHls.instances.length).toBeGreaterThan(before));
    (FakeHls.instances.at(-1) as FakeHls).fire(FakeHls.Events.ERROR, { type: 'networkError', details: 'manifestLoadError', fatal: true, error: new Error('404') });
    await expect(loading).rejects.toMatchObject({ type: 'network', details: 'manifestLoadError', fatal: true });
    FakeHls.supported = false;
    await expect(createHlsJsEngine(ctx()).load()).rejects.toMatchObject({ details: 'engineUnsupported' });
    FakeHls.supported = true;
    await expect(createHlsJsEngine(ctx({ source: { src: new Blob() } })).load()).rejects.toMatchObject({ details: 'unsupportedSource' });
  });

  it('rejects load on manifestIncompatibleCodecsError instead of trying media recovery', async () => {
    const engine = createHlsJsEngine(ctx());
    const before = FakeHls.instances.length;
    const loading = engine.load();
    await vi.waitFor(() => expect(FakeHls.instances.length).toBeGreaterThan(before));
    const hls = FakeHls.instances.at(-1) as FakeHls;
    hls.fire(FakeHls.Events.ERROR, { type: 'mediaError', details: 'manifestIncompatibleCodecsError', fatal: true, error: new Error('hevc') });
    await expect(loading).rejects.toMatchObject({ details: 'manifestIncompatibleCodecsError', fatal: true });
    expect(hls.calls).not.toContain('recoverMediaError');
  });

  it('reports latency only for live playlists', async () => {
    const { engine, hls } = await loaded();
    hls.latency = 8;
    expect(engine.latency).toBeUndefined();
    hls.latestLevelDetails = { live: true };
    expect(engine.latency).toBe(8);
  });

  it('maps hls.js error types to the unified model', () => {
    expect(mapHlsError({ type: 'keySystemError' as never, details: 'keySystemNoKeys' as never, fatal: true, error: new Error() })).toMatchObject({ type: 'drm', fatal: true, recoverable: false });
    expect(mapHlsError({ type: 'muxError' as never, details: 'fragParsingError' as never, fatal: false, error: new Error() })).toMatchObject({ type: 'mux' });
  });
});
