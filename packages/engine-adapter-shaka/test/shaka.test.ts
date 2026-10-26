import { describe, expect, it, vi } from 'vitest';
import { createQoeHook } from '@otter-player/core';
import { NO_CAPABILITIES, NO_CODEC_RANKING, type EngineContext, type EngineEvents } from '@otter-player/media';

type Listener = (event: { detail?: unknown }) => void;

const variant = (id: number, over: Record<string, unknown>) => ({
  id,
  active: false,
  type: 'variant',
  bandwidth: 0,
  width: null,
  height: null,
  frameRate: null,
  videoCodec: 'avc1.4d401e',
  audioCodec: 'mp4a.40.2',
  codecs: null,
  hdr: null,
  language: 'en',
  label: null,
  videoId: id,
  audioId: 100,
  channelsCount: 2,
  audioBandwidth: 128_000,
  ...over,
});

class FakePlayer {
  static instances: FakePlayer[] = [];
  static supported = true;
  static nextLoadError: unknown;
  static isBrowserSupported = (): boolean => FakePlayer.supported;
  listeners = new Map<string, Listener[]>();
  configs: Record<string, unknown>[] = [];
  calls: string[] = [];
  loadError: unknown;
  variants = [
    variant(1, { bandwidth: 600_000, width: 640, height: 360, active: true }),
    variant(2, { bandwidth: 2_400_000, width: 1280, height: 720, hdr: 'PQ' }),
    variant(3, { bandwidth: 600_000, width: 640, height: 360, audioId: 101, language: 'fr', videoId: 1 }),
  ];
  constructor() {
    this.loadError = FakePlayer.nextLoadError;
    FakePlayer.nextLoadError = undefined;
    FakePlayer.instances.push(this);
  }
  addEventListener(type: string, l: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  fire(type: string, detail?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ detail });
  }
  attach = async (): Promise<void> => {
    this.calls.push('attach');
  };
  load = async (uri: string, start: number | null): Promise<void> => {
    this.calls.push(`load:${uri}@${start}`);
    if (this.loadError !== undefined) throw this.loadError;
  };
  configure = (c: Record<string, unknown>): boolean => {
    this.configs.push(c);
    return true;
  };
  getVariantTracks = () => this.variants;
  getTextTracks = () => [{ id: 7, active: false, kind: 'subtitle', label: null, language: 'en', mimeType: 'text/vtt' }];
  selectVariantTrack = (t: { id: number }) => this.calls.push(`select:${t.id}`);
  getStats = () => ({ estimatedBandwidth: 5_000_000, liveLatency: Number.NaN, droppedFrames: 0, decodedFrames: 10, streamBandwidth: 0 });
  isLive = () => false;
  seekRange = () => ({ start: 0, end: 10 });
  filters: ((type: number, request: { uris: string[]; headers: Record<string, string> }, context?: object) => void)[] = [];
  getNetworkingEngine = () => ({ registerRequestFilter: (f: FakePlayer['filters'][number]) => this.filters.push(f) });
  destroy = async (): Promise<void> => {
    this.calls.push('destroy');
  };
}

const installAll = vi.fn();
// Shaka is a CommonJS bundle; the namespace may sit behind `default`.
vi.mock('shaka-player', () => ({ default: { Player: FakePlayer, polyfill: { installAll } } }));

const { createShakaEngine, mapShakaError, mapShakaTracks } = await import('@otter-player/engine-adapter-shaka');
// Lazy glue module, imported by path (not re-exported from the package index).
const { shakaCmcdRequest } = await import('../src/cmcd.js');

const ctx = (overrides: Partial<EngineContext> = {}): EngineContext => ({
  source: { src: 'https://e.test/a.mpd', drm: { servers: { 'com.widevine.alpha': 'https://lic' }, clearKeys: { aa: 'bb' } } },
  options: { startTime: 3 },
  caps: NO_CAPABILITIES,
  codecs: NO_CODEC_RANKING,
  backend: 'mse',
  qoe: createQoeHook(),
  media: {} as HTMLMediaElement,
  mms: false,
  allowCodecSwitch: false,
  ...overrides,
});

describe('Shaka adapter', () => {
  it('installs polyfills, maps DRM config, attaches and loads', async () => {
    const engine = createShakaEngine(ctx());
    const events: [keyof EngineEvents, unknown][] = [];
    engine.on('bandwidth', (p) => events.push(['bandwidth', p]));
    await engine.load();
    const p = FakePlayer.instances.at(-1) as FakePlayer;
    expect(installAll).toHaveBeenCalled();
    expect(p.calls).toEqual(['attach', 'load:https://e.test/a.mpd@3']);
    expect(p.configs[0]).toMatchObject({
      abr: { enabled: true },
      drm: { servers: { 'com.widevine.alpha': 'https://lic' }, clearKeys: { aa: 'bb' } },
    });
    expect(engine.formatId).toBe('dash');
    // Otter ABR is installed through abrFactory (ADR-005 §1).
    const factory = p.configs[0]?.['abrFactory'] as (() => { chooseVariant: unknown }) | undefined;
    expect(typeof factory?.().chooseVariant).toBe('function');
    expect(events).toContainEqual(['bandwidth', { estimate: 5_000_000, fast: 5_000_000, slow: 5_000_000, estimated: true }]);
  });

  it('maps variants sharing the active audio to qualities', () => {
    const p = new FakePlayer();
    const tracks = mapShakaTracks(p.getVariantTracks(), p.getTextTracks(), true);
    expect(tracks.video.map((v) => [v.id, v.height, v.selected, v.dynamicRange])).toEqual([
      ['variant-1', 360, true, undefined],
      ['variant-2', 720, false, 'hdr10'],
    ]);
    expect(tracks.audio.map((a) => [a.id, a.language])).toEqual([
      ['audio-100', 'en'],
      ['audio-101', 'fr'],
    ]);
    expect(tracks.text).toEqual([{ kind: 'text', id: 'text-7', role: 'subtitles', selected: false, language: 'en', format: 'vtt' }]);
    expect(tracks.requestedQuality).toBe('auto');
  });

  it('manual selection disables ABR, auto re-enables it', async () => {
    const engine = createShakaEngine(ctx());
    await engine.load();
    const p = FakePlayer.instances.at(-1) as FakePlayer;
    engine.selectQuality('variant-2');
    expect(p.configs.at(-1)).toEqual({ abr: { enabled: false } });
    expect(p.calls.at(-1)).toBe('select:2');
    engine.selectQuality('auto');
    expect(p.configs.at(-1)).toEqual({ abr: { enabled: true } });
    // The active variant: only ABR off. Shaka would force-clear every stream, audio too.
    const before = p.calls.length;
    engine.selectQuality('variant-1');
    expect(p.configs.at(-1)).toEqual({ abr: { enabled: false } });
    expect(p.calls.slice(before)).not.toContain('select:1');
  });

  it('a reload on the same element attaches only after the previous player finished detaching', async () => {
    const media = {} as HTMLMediaElement;
    const first = createShakaEngine(ctx({ media }));
    await first.load();
    const p1 = FakePlayer.instances.at(-1) as FakePlayer;
    let finish: () => void = () => undefined;
    p1.destroy = () => new Promise<void>((r) => (finish = r));
    first.destroy();
    const second = createShakaEngine(ctx({ media }));
    const loading = second.load();
    await vi.waitFor(() => expect(FakePlayer.instances.at(-1)).not.toBe(p1));
    const p2 = FakePlayer.instances.at(-1) as FakePlayer;
    await new Promise((r) => setTimeout(r, 10));
    expect(p2.calls).not.toContain('attach');
    finish();
    await loading;
    expect(p2.calls.slice(0, 2)).toEqual(['attach', 'load:https://e.test/a.mpd@3']);
  });

  it('maps Shaka errors and rejects load with them', async () => {
    expect(mapShakaError({ severity: 2, category: 6, code: 6007 })).toMatchObject({ type: 'drm', details: 'shaka6007', fatal: true });
    expect(mapShakaError({ severity: 1, category: 1, code: 1001 })).toMatchObject({ type: 'network', fatal: false, recoverable: true });
    FakePlayer.nextLoadError = { severity: 2, category: 4, code: 4000 };
    await expect(createShakaEngine(ctx()).load()).rejects.toMatchObject({ type: 'network', details: 'shaka4000', fatal: true });
  });

  it('prefers the wall-clock live latency', async () => {
    const engine = createShakaEngine(ctx());
    await engine.load();
    const p = FakePlayer.instances.at(-1) as FakePlayer & { getLiveLatency?: () => number | null };
    p.isLive = () => true;
    p.getLiveLatency = () => 3200;
    expect(engine.latency).toBe(3.2);
    p.getLiveLatency = () => null;
    expect(engine.latency).toBeUndefined();
  });

  it("abr: 'engine' keeps Shaka's own AbrManager", async () => {
    await createShakaEngine(ctx(), { abr: 'engine' }).load();
    const p = FakePlayer.instances.at(-1) as FakePlayer;
    expect(p.configs[0]?.['abrFactory']).toBeUndefined();
  });

  it('maps Shaka requests to CMCD and never decorates license requests', () => {
    expect(shakaCmcdRequest(0, 'm.mpd')).toEqual({ url: 'm.mpd', kind: 'manifest' });
    expect(shakaCmcdRequest(1, 'i.mp4', { type: 0 })).toEqual({ url: 'i.mp4', kind: 'init' });
    expect(shakaCmcdRequest(1, 's.m4s', { type: 1, stream: { type: 'video', bandwidth: 2e6 }, segment: { startTime: 4, endTime: 8 } })).toEqual({
      url: 's.m4s',
      kind: 'video',
      durationS: 4,
      bitrateBps: 2e6,
    });
    expect(shakaCmcdRequest(1, 'a.m4s', { stream: { type: 'audio' } })).toMatchObject({ kind: 'audio' });
    expect(shakaCmcdRequest(2, 'https://lic')).toBeUndefined();
  });

  it('request filter decorates every uri with CMCD', async () => {
    const decorate = (r: { url: string; kind: string }) => ({ url: `${r.url}?CMCD=${r.kind}`, headers: { 'CMCD-Session': 'x' } });
    await createShakaEngine(ctx({ cmcd: { mode: 'query', sessionId: 'x', decorate } })).load();
    const p = FakePlayer.instances.at(-1) as FakePlayer;
    const request = { uris: ['https://a/s.m4s', 'https://b/s.m4s'], headers: {} as Record<string, string> };
    p.filters[0]?.(1, request, { type: 1, stream: { type: 'video' } });
    expect(request.uris).toEqual(['https://a/s.m4s?CMCD=video', 'https://b/s.m4s?CMCD=video']);
    expect(request.headers).toEqual({ 'CMCD-Session': 'x' });
    const license = { uris: ['https://lic'], headers: {} as Record<string, string> };
    p.filters[0]?.(2, license);
    expect(license.uris).toEqual(['https://lic']);
  });

  it('reports unsupported browsers', async () => {
    FakePlayer.supported = false;
    await expect(createShakaEngine(ctx()).load()).rejects.toMatchObject({ details: 'engineUnsupported' });
    FakePlayer.supported = true;
  });
});
