import { describe, expect, it, vi } from 'vitest';
import { createQoeHook } from '@otter-player/core';
import { NO_CAPABILITIES, type EngineContext, type EngineEvents } from '@otter-player/media';

type Listener = (...args: unknown[]) => void;

const Events = { ERROR: 'error', MEDIA_INFO: 'media_info', STATISTICS_INFO: 'statistics_info' };

class FakeMpegtsPlayer {
  static last: FakeMpegtsPlayer | undefined;
  listeners = new Map<string, Listener[]>();
  calls: string[] = [];
  source: Record<string, unknown>;
  config: Record<string, unknown>;
  constructor(source: Record<string, unknown>, config: Record<string, unknown>) {
    this.source = source;
    this.config = config;
    FakeMpegtsPlayer.last = this;
  }
  on(e: string, l: Listener): void {
    this.listeners.set(e, [...(this.listeners.get(e) ?? []), l]);
  }
  fire(e: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(e) ?? []) l(...args);
  }
  attachMediaElement = () => this.calls.push('attach');
  detachMediaElement = () => this.calls.push('detach');
  load = () => this.calls.push('load');
  unload = () => this.calls.push('unload');
  destroy = () => this.calls.push('destroy');
}

let supported = true;
vi.mock('mpegts.js', () => ({
  default: {
    isSupported: () => supported,
    createPlayer: (s: Record<string, unknown>, c: Record<string, unknown>) => new FakeMpegtsPlayer(s, c),
    Events,
  },
}));

const { createMpegtsEngine, mapMpegtsError } = await import('@otter-player/engine-adapter-mpegts');

const media = Object.assign(new EventTarget(), {
  buffered: { length: 1, start: () => 0, end: () => 10 },
  currentTime: 8.5,
  videoWidth: 640,
  videoHeight: 360,
}) as unknown as HTMLMediaElement;
const ctx = (live: boolean): EngineContext => ({
  source: { src: 'https://e.test/live.flv', live, headers: { 'x-token': 't' } },
  options: {},
  caps: NO_CAPABILITIES,
  backend: 'mse',
  qoe: createQoeHook(),
  media,
  mms: false,
  allowCodecSwitch: false,
});

const flushImport = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('mpegts.js adapter', () => {
  it('creates a live FLV player with latency chasing and maps media info', async () => {
    const engine = createMpegtsEngine(ctx(true), { type: 'flv' });
    const events: [keyof EngineEvents, unknown][] = [];
    for (const e of ['tracks-change', 'bandwidth', 'latency-change', 'first-segment', 'error'] as const) {
      engine.on(e, (p) => events.push([e, p]));
    }
    const loading = engine.load();
    await flushImport();
    const p = FakeMpegtsPlayer.last as FakeMpegtsPlayer;
    expect(p.source).toEqual({ type: 'flv', isLive: true, url: 'https://e.test/live.flv' });
    expect(p.config).toMatchObject({ liveBufferLatencyChasing: true, liveSync: true, lazyLoad: false, headers: { 'x-token': 't' } });
    expect(p.calls).toEqual(['attach', 'load']);
    p.fire(Events.MEDIA_INFO, { width: 1280, height: 720, fps: 25, videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.2', videoDataRate: 1500, audioDataRate: 128 });
    await loading;
    expect(engine.formatId).toBe('flv');
    expect(engine.tracks.video[0]).toMatchObject({ width: 1280, height: 720, frameRate: 25, bitrate: 1_628_000 });
    p.fire(Events.STATISTICS_INFO, { speed: 100, decodedFrames: 5 });
    expect(events).toContainEqual(['bandwidth', { estimate: 819_200, fast: 819_200, slow: 819_200 }]);
    expect(events).toContainEqual(['latency-change', { latency: 1.5 }]);
    expect(events.filter(([e]) => e === 'first-segment')).toHaveLength(1);
    p.fire(Events.ERROR, 'NetworkError', 'HttpStatusCodeInvalid', { code: 404, msg: 'not found' });
    expect(events.at(-1)).toEqual(['error', expect.objectContaining({ type: 'network', details: 'HttpStatusCodeInvalid', fatal: true })]);
    engine.destroy();
    expect(p.calls.slice(-3)).toEqual(['unload', 'detach', 'destroy']);
  });

  it('treats sources as VOD unless live is set, and rejects load on early errors', async () => {
    const engine = createMpegtsEngine({ ...ctx(false), source: { src: 'https://e.test/clip.ts' } }, { type: 'mpegts' });
    const loading = engine.load();
    await flushImport();
    const p = FakeMpegtsPlayer.last as FakeMpegtsPlayer;
    expect(p.source).toMatchObject({ type: 'mpegts', isLive: false });
    expect(p.config).toMatchObject({ liveBufferLatencyChasing: false, lazyLoad: true });
    p.fire(Events.ERROR, 'MediaError', 'MediaMSEError', { msg: 'unsupported codec' });
    await expect(loading).rejects.toMatchObject({ type: 'media', details: 'MediaMSEError', message: 'unsupported codec' });
    expect(engine.formatId).toBe('ts');
  });

  it('decorates the single FLV request with CMCD once', async () => {
    const decorate = vi.fn((r: { url: string; kind: string }) => ({ url: `${r.url}&CMCD=${r.kind}`, headers: { 'CMCD-Session': 's' } }));
    const engine = createMpegtsEngine({ ...ctx(true), cmcd: { mode: 'query', sessionId: 's', decorate } }, { type: 'flv' });
    const loading = engine.load();
    await flushImport();
    const p = FakeMpegtsPlayer.last as FakeMpegtsPlayer;
    expect(decorate).toHaveBeenCalledOnce();
    expect(p.source['url']).toBe('https://e.test/live.flv&CMCD=muxed');
    expect(p.config['headers']).toEqual({ 'x-token': 't', 'CMCD-Session': 's' });
    p.fire(Events.MEDIA_INFO, {});
    await loading;
  });

  it('resolves load from the element when mpegts.js never reports media info (video-only TS)', async () => {
    const engine = createMpegtsEngine({ ...ctx(false), source: { src: 'https://e.test/cam.ts' } }, { type: 'mpegts' });
    const loading = engine.load();
    await flushImport();
    media.dispatchEvent(new Event('loadedmetadata'));
    await loading;
    expect(engine.tracks.video[0]).toMatchObject({ id: 'main', width: 640, height: 360 });
    expect(engine.tracks.audio).toEqual([]);
  });

  it('reports unsupported environments', async () => {
    supported = false;
    await expect(createMpegtsEngine(ctx(true), { type: 'flv' }).load()).rejects.toMatchObject({ details: 'engineUnsupported' });
    supported = true;
    expect(mapMpegtsError('OtherError', '', undefined)).toMatchObject({ type: 'other', details: 'mpegtsError' });
  });
});
