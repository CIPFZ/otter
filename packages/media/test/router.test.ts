import { describe, expect, it } from 'vitest';
import {
  createRouter,
  NO_CAPABILITIES,
  type BackendKind,
  type Capabilities,
  type FormatPlugin,
  type Source,
} from '@otter-player/media';

const format = (id: string, score: number, backends: readonly BackendKind[]): FormatPlugin => ({
  id,
  probe: () => score,
  backends: () => backends,
  createEngine: () => {
    throw new Error('unused');
  },
});

const hls = format('hls', 1, ['native', 'mse']);
const dash = format('dash', 1, ['mse']);
const desktop: Capabilities = { ...NO_CAPABILITIES, mediaSource: true, webCodecs: true };
const iPhone: Capabilities = { ...NO_CAPABILITIES, managedMediaSource: true, nativeHls: true };
const oldIPhone: Capabilities = { ...NO_CAPABILITIES, nativeHls: true };
const src: Source = { src: 'https://example.test/a.m3u8' };
const all: BackendKind[] = ['native', 'mse', 'webcodecs'];

describe('router.select', () => {
  it('desktop defaults to MSE with native as fallback', () => {
    const d = createRouter({ formats: [hls], backends: all }).select(src, desktop);
    expect(d.step).toEqual({ backend: 'mse' });
    expect(d.remaining).toEqual([{ backend: 'native' }]);
    expect(d.explanation).toMatchObject({ format: 'hls', backend: 'mse' });
  });

  it('picks the highest probe score, ties keep registration order', () => {
    const r = createRouter({ formats: [format('a', 0.5, ['mse']), format('b', 0.9, ['mse']), format('c', 0.9, ['mse'])], backends: all });
    expect(r.select(src, desktop).format.id).toBe('b');
  });

  it('iPhone HLS without DRM or quality switching goes native first', () => {
    const r = createRouter({ formats: [hls], backends: all });
    expect(r.select(src, iPhone).step.backend).toBe('native');
    expect(r.select(src, iPhone).remaining.map((s) => s.backend)).toEqual(['mse']);
  });

  it('iPhone with quality switching, DRM or DASH needs ManagedMediaSource', () => {
    const r = createRouter({ formats: [hls, dash], backends: all });
    expect(r.select(src, iPhone, { needsQualitySwitch: true }).step.backend).toBe('mse');
    expect(r.select({ ...src, drm: { servers: { 'com.apple.fps': 'https://lic' } } }, iPhone).step.backend).toBe('mse');
    const dashOnly = createRouter({ formats: [dash], backends: all });
    expect(dashOnly.select(src, iPhone).step.backend).toBe('mse');
  });

  it('old iPhone (no MSE, no MMS) can only play HLS natively', () => {
    const r = createRouter({ formats: [hls], backends: all });
    expect(r.select(src, oldIPhone, { needsQualitySwitch: true })).toMatchObject({ step: { backend: 'native' }, remaining: [] });
    const steps = r.explain()?.steps ?? [];
    expect(steps).toContainEqual({ candidate: 'mse', outcome: 'rejected', reason: 'no MediaSource / ManagedMediaSource' });
  });

  it('HEVC without decoding support walks webcodecs -> wasm -> mse -> native', () => {
    const flv = format('flv', 1, ['mse', 'native', 'webcodecs']);
    const r = createRouter({ formats: [flv], backends: all, decoders: [{ id: 'wasm-hevc', supports: async () => 'software', create: () => { throw new Error(); } }] });
    const d = r.select({ ...src, codecs: 'hvc1.1.6.L93.B0,mp4a.40.2' }, desktop);
    expect([d.step, ...d.remaining]).toEqual([
      { backend: 'webcodecs', decoder: 'webcodecs' },
      { backend: 'webcodecs', decoder: 'wasm' },
      { backend: 'mse' },
      { backend: 'native' },
    ]);
    const supported = { ...desktop, codecs: { 'video/mp4; codecs="hvc1.1.6.L93.B0"': { supported: true, smooth: true, powerEfficient: true } } };
    expect(r.select({ ...src, codecs: 'hvc1.1.6.L93.B0' }, supported).step.backend).toBe('mse');
  });

  it('rejects unregistered backends, WASM without decoder, and formats that cannot feed a backend', () => {
    const r = createRouter({ formats: [dash], backends: ['mse', 'native'] });
    const d = r.select({ ...src, codecs: 'hev1.1.6.L93.B0' }, desktop);
    expect(d.step.backend).toBe('mse');
    expect(d.remaining).toEqual([]);
    const reasons = Object.fromEntries((r.explain()?.steps ?? []).filter((s) => s.outcome === 'rejected' && !s.candidate.startsWith('format:')).map((s) => [s.candidate, s.reason]));
    expect(reasons).toEqual({
      webcodecs: 'format dash cannot feed webcodecs for this source',
      wasm: 'format dash cannot feed webcodecs for this source',
      native: 'format dash cannot feed native for this source',
    });
  });

  it('honours preferBackend and forbidBackend', () => {
    const r = createRouter({ formats: [hls], backends: all });
    expect(r.select(src, desktop, { preferBackend: 'native' }).step.backend).toBe('native');
    expect(r.explain()?.steps.at(-1)).toEqual({ candidate: 'native', outcome: 'selected', reason: 'preferred by policy' });
    expect(r.select(src, desktop, { forbidBackend: ['mse'] }).step.backend).toBe('native');
  });

  it('throws fatal noFormat / noRoute and still explains', () => {
    const r = createRouter({ formats: [format('x', 0, ['mse'])], backends: all });
    expect(() => r.select(src, desktop)).toThrow(expect.objectContaining({ details: 'noFormat', fatal: true }));
    expect(r.explain()).toMatchObject({ format: null, backend: null });
    const r2 = createRouter({ formats: [dash], backends: ['native'] });
    expect(() => r2.select(src, desktop)).toThrow(expect.objectContaining({ details: 'noRoute' }));
    expect(r2.explain()).toMatchObject({ format: 'dash', backend: null });
  });

  it('is deterministic', () => {
    const r = createRouter({ formats: [hls, dash], backends: all });
    expect(r.select(src, iPhone)).toEqual(r.select(src, iPhone));
  });
});

describe('router.fallback', () => {
  it('moves down the remaining chain and records the failure', () => {
    const r = createRouter({ formats: [hls], backends: all });
    const first = r.select(src, desktop);
    r.annotate({ candidate: 'mse', outcome: 'selected', reason: 'mms: disableRemotePlayback' });
    const second = r.fallback(first, 'mediaDecodeError');
    expect(second?.step.backend).toBe('native');
    const steps = r.explain()?.steps ?? [];
    expect(steps.slice(-3)).toEqual([
      { candidate: 'mse', outcome: 'selected', reason: 'mms: disableRemotePlayback' },
      { candidate: 'mse', outcome: 'failed', reason: 'mediaDecodeError' },
      { candidate: 'native', outcome: 'selected', reason: 'fallback after mse' },
    ]);
    expect(r.fallback(second as NonNullable<typeof second>, 'mediaSrcNotSupported')).toBeNull();
    expect(r.explain()).toMatchObject({ backend: null });
  });
});
