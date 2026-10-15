import { describe, expect, it } from 'vitest';
import { createCore, createError } from '@otter-player/core';
import { createQoeCollector, createQoePlugin, EMPTY_QOE, QOE_SLICE, type QoeState } from '@otter-player/qoe';

const route = (backend: string) => ({ format: 'hls', backend, steps: [] });

describe('QoE collector', () => {
  it('aggregates one playback session', () => {
    const core = createCore();
    const c = createQoeCollector(core.qoe);
    core.qoe.emit('route', route('mse'));
    core.qoe.emit('startup', { ttff: 420, firstSegmentMs: 180, backend: 'mse', format: 'hls', codec: 'avc1.64001f' });
    core.qoe.emit('rebuffer', { position: 3, startedAt: 0, endedAt: 250, duration: 250 });
    core.qoe.emit('rebuffer', { position: 9, startedAt: 0, endedAt: 100, duration: 100 });
    core.qoe.emit('quality-switch', { from: null, to: 'level-2', reason: 'abr', mode: 'auto' });
    core.qoe.emit('bandwidth', { estimate: 4e6, fast: 4e6, slow: 4e6 });
    core.qoe.emit('latency', { latency: 2.5, target: 3 });
    core.qoe.emit('dropped-frames', { dropped: 2, total: 300 });
    core.qoe.emit('error', {
      error: createError({ type: 'network', details: 'fragLoadError', fatal: false, recoverable: true }),
      fallback: [],
    });
    expect(c.snapshot()).toMatchObject({
      ttff: 420,
      firstSegmentMs: 180,
      backend: 'mse',
      format: 'hls',
      codec: 'avc1.64001f',
      rebufferCount: 2,
      rebufferDuration: 350,
      qualitySwitches: 1,
      lastQualitySwitch: { from: null, to: 'level-2', mode: 'auto' },
      bandwidth: 4e6,
      latency: 2.5,
      targetLatency: 3,
      droppedFrames: 2,
      totalFrames: 300,
      errors: 1,
      lastError: { type: 'network', details: 'fragLoadError', fatal: false },
    });
  });

  it('keeps the session across fallback routes and resets after exit', () => {
    const core = createCore();
    const c = createQoeCollector(core.qoe);
    core.qoe.emit('route', route('mse'));
    core.qoe.emit('rebuffer', { position: 1, startedAt: 0, duration: 10 });
    core.qoe.emit('route', route('native'));
    expect(c.snapshot()).toMatchObject({ backend: 'native', rebufferCount: 1 });
    core.qoe.emit('exit', { position: 5, watched: 4.5 });
    expect(c.snapshot().watched).toBe(4.5);
    core.qoe.emit('route', route('mse'));
    expect(c.snapshot()).toEqual({ ...EMPTY_QOE, route: route('mse'), backend: 'mse', format: 'hls' });
  });

  it('mirrors the snapshot into the store', async () => {
    const core = createCore<QoeState, object>({ slices: [QOE_SLICE], plugins: [createQoePlugin()] });
    await core.start();
    core.qoe.emit('route', route('mse'));
    core.qoe.emit('bandwidth', { estimate: 1e6, fast: 1e6, slow: 1e6 });
    expect(core.store.getState().qoe).toMatchObject({ backend: 'mse', bandwidth: 1e6 });
    await core.destroy();
  });
});
