import { describe, expect, it, vi } from 'vitest';
import { createQoeHook } from '@otter-player/core';
import { NO_CAPABILITIES, type EngineContext, type EngineEvents } from '@otter-player/media';

type Handler = (event: string, data: Record<string, unknown>) => void;

// Minimal stand-in for hls.js: records calls and lets the test fire hls.js events.
class FakeHls {
  static instances: FakeHls[] = [];
  static supported = true;
  static isSupported = (): boolean => FakeHls.supported;
  static DefaultConfig = {
    loader: class {
      loads: { url: string; headers?: Record<string, string> }[] = [];
      load(context: { url: string; headers?: Record<string, string> }): void {
        FakeHls.loaded.push({ url: context.url, ...(context.headers === undefined ? {} : { headers: context.headers }) });
      }
    },
  };
  static loaded: { url: string; headers?: Record<string, string> }[] = [];
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
  loadLevel = 0;
  minAutoLevel = 0;
  maxAutoLevel = 1;
  lowLatencyMode = false;
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

// Stand-in for hls.js' AbrController: the engine choice is fixed, forcedAutoLevel settable.
class FakeAbrController {
  hls: unknown;
  forcedAutoLevel = -1;
  engineChoice = 0;
  #next = -1;
  constructor(hls: unknown) {
    this.hls = hls;
  }
  get nextAutoLevel(): number {
    return this.engineChoice;
  }
  set nextAutoLevel(v: number) {
    this.#next = v;
  }
  get lastSet(): number {
    return this.#next;
  }
}

vi.mock('hls.js', () => ({ default: FakeHls, AbrController: FakeAbrController }));

const { createHlsJsEngine, mapHlsError } = await import('@otter-player/engine-adapter-hlsjs');
// Lazy glue modules are not re-exported from the package index (they would reach the first screen).
const { fragmentRequest } = await import('../src/cmcd.js');

const ctx = (overrides: Partial<EngineContext> = {}): EngineContext => ({
  source: { src: 'https://e.test/a.m3u8' },
  options: { startTime: 12 },
  caps: NO_CAPABILITIES,
  backend: 'mse',
  qoe: createQoeHook(),
  media: Object.assign(new EventTarget(), {
    buffered: { length: 1, start: () => 0, end: () => 20 },
    currentTime: 2,
  }) as unknown as HTMLMediaElement,
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
  const Abr = hls.config['abrController'] as (new (h: unknown) => FakeAbrController) | undefined;
  const abr = Abr === undefined ? undefined : new Abr(hls);
  return { engine, hls, events, abr };
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
    // No bandwidth sample yet: the switch came from hls.js' startup logic, and the reason says so.
    expect(events).toContainEqual(['quality-change', { id: 'level-1', auto: true, reason: 'abr (hls.js startup / emergency)' }]);
    expect(events.filter(([e]) => e === 'first-segment')).toHaveLength(1);
    expect(events).toContainEqual(['bandwidth', { estimate: 3_000_000, fast: 3_000_000, slow: 3_000_000 }]);
    engine.selectQuality('level-1');
    expect(hls.currentLevel).toBe(1);
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

  it('Otter ABR: engine choice before the first sample, rule stack after, caps and forced levels kept', async () => {
    const { hls, abr, events } = await loaded();
    expect(abr).toBeDefined();
    const a = abr as FakeAbrController;
    a.engineChoice = 0;
    expect(a.nextAutoLevel).toBe(0); // no bandwidth sample yet: hls.js startup logic
    // 4 MB in 1 s = 32 Mbps: rules want the top level (index 1).
    for (let i = 0; i < 4; i++) {
      hls.fire(FakeHls.Events.FRAG_LOADED, { frag: { type: 'main', stats: { aborted: false, loaded: 4_000_000, loading: { start: 0, first: 50, end: 1050 } } } });
      hls.fire(FakeHls.Events.FRAG_BUFFERED, { frag: { type: 'main' } });
    }
    expect(a.nextAutoLevel).toBe(1);
    hls.maxAutoLevel = 0; // e.g. capLevelToPlayerSize
    expect(a.nextAutoLevel).toBe(0);
    hls.maxAutoLevel = 1;
    a.forcedAutoLevel = 0; // hls.js emergency abandonment
    expect(a.nextAutoLevel).toBe(0);
    a.forcedAutoLevel = -1;
    a.nextAutoLevel = 1; // setter still reaches hls.js
    expect(a.lastSet).toBe(1);
    expect(events).toContainEqual(['bandwidth', expect.objectContaining({ fast: expect.any(Number), slow: expect.any(Number) })]);
    hls.fire(FakeHls.Events.LEVEL_SWITCHED, { level: 1 });
    expect(events.filter(([e]) => e === 'quality-change').at(-1)?.[1]).toMatchObject({ id: 'level-1', reason: expect.stringMatching(/^abr: /) });
  });

  it("abr: 'engine' leaves hls.js' own ABR in place", async () => {
    const engine = createHlsJsEngine(ctx(), { abr: 'engine' });
    const before = FakeHls.instances.length;
    const loading = engine.load();
    await vi.waitFor(() => expect(FakeHls.instances.length).toBeGreaterThan(before));
    const hls = FakeHls.instances.at(-1) as FakeHls;
    expect(hls.config['abrController']).toBeUndefined();
    hls.fire(FakeHls.Events.MANIFEST_PARSED);
    await loading;
  });

  it('maps fragment requests to CMCD object types, bitrate and duration', () => {
    const hls = { levels: [{ bitrate: 800_000, audioCodec: 'mp4a.40.2', videoCodec: 'avc1' }, { bitrate: 2_000_000, videoCodec: 'avc1' }] } as never;
    const frag = (over: Record<string, unknown>) => ({ url: 'u', part: null, frag: { sn: 1, type: 'main', level: 0, duration: 4, ...over } }) as never;
    expect(fragmentRequest(frag({}), hls)).toEqual({ url: 'u', kind: 'muxed', durationS: 4, bitrateBps: 800_000 });
    expect(fragmentRequest(frag({ level: 1 }), hls)).toMatchObject({ kind: 'video', bitrateBps: 2_000_000 });
    expect(fragmentRequest(frag({ sn: 'initSegment' }), hls)).toEqual({ url: 'u', kind: 'init', bitrateBps: 800_000 });
    expect(fragmentRequest(frag({ type: 'audio' }), hls)).toEqual({ url: 'u', kind: 'audio', durationS: 4 });
    expect(fragmentRequest(frag({ type: 'subtitle' }), hls)).toMatchObject({ kind: 'caption' });
  });

  it('installs CMCD fLoader / pLoader that decorate every request', async () => {
    const decorate = vi.fn((r: { url: string; kind: string }) => ({ url: `${r.url}?CMCD=${r.kind}`, headers: { 'CMCD-Session': 'sid' } }));
    const engine = createHlsJsEngine(ctx({ cmcd: { mode: 'query', sessionId: 'sid', decorate } }));
    const before = FakeHls.instances.length;
    const loading = engine.load();
    await vi.waitFor(() => expect(FakeHls.instances.length).toBeGreaterThan(before));
    const hls = FakeHls.instances.at(-1) as FakeHls;
    const P = hls.config['pLoader'] as new (c: unknown) => { load(c: object, cfg: object, cb: object): void };
    const F = hls.config['fLoader'] as new (c: unknown) => { load(c: object, cfg: object, cb: object): void };
    new P({}).load({ url: 'https://e.test/a.m3u8' }, {}, {});
    new F({}).load({ url: 'https://e.test/1.ts', part: null, frag: { sn: 1, type: 'main', level: 0, duration: 4 } }, {}, {});
    expect(FakeHls.loaded.slice(-2)).toEqual([
      { url: 'https://e.test/a.m3u8?CMCD=manifest', headers: { 'CMCD-Session': 'sid' } },
      { url: 'https://e.test/1.ts?CMCD=video', headers: { 'CMCD-Session': 'sid' } },
    ]);
    hls.fire(FakeHls.Events.MANIFEST_PARSED);
    await loading;
  });

  it('maps hls.js error types to the unified model', () => {
    expect(mapHlsError({ type: 'keySystemError' as never, details: 'keySystemNoKeys' as never, fatal: true, error: new Error() })).toMatchObject({ type: 'drm', fatal: true, recoverable: false });
    expect(mapHlsError({ type: 'muxError' as never, details: 'fragParsingError' as never, fatal: false, error: new Error() })).toMatchObject({ type: 'mux' });
  });
});
