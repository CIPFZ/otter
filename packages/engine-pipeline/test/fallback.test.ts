import { describe, expect, it } from 'vitest';
import { createError, createEventBus, type OtterError } from '@otter-player/core';
import { EMPTY_TRACKS, type Engine, type EngineEvents } from '@otter-player/media';
import { withAdapterFallback } from '@otter-player/engine-pipeline';

function fakeEngine(name: string, fail?: OtterError): Engine & { calls: string[]; emit: <E extends keyof EngineEvents>(e: E, p: EngineEvents[E]) => void } {
  const bus = createEventBus<EngineEvents>();
  const calls: string[] = [];
  return {
    formatId: name,
    tracks: EMPTY_TRACKS,
    mms: false,
    calls,
    emit: (e, p) => bus.emit(e, p),
    async load() {
      calls.push('load');
      if (fail !== undefined) throw fail;
    },
    selectQuality: (id) => void calls.push(`quality:${id}`),
    on: (e, h) => bus.on(e, (p) => h(p)),
    destroy: () => void calls.push('destroy'),
  };
}

describe('withAdapterFallback', () => {
  it('a media error (codec the pipeline lacks) rebuilds once with the adapter and says so', async () => {
    const own = fakeEngine('own', createError({ type: 'media', details: 'flvCodecUnsupported', fatal: true, recoverable: false }));
    const adapter = fakeEngine('adapter');
    const e = withAdapterFallback(own, () => adapter);
    const errors: string[] = [];
    const firsts: number[] = [];
    e.on('error', (err) => void errors.push(err.details));
    e.on('first-segment', ({ at }) => void firsts.push(at));
    await e.load();
    expect(own.calls).toEqual(['load', 'destroy']);
    expect(adapter.calls).toEqual(['load']);
    expect(errors).toEqual(['pipelineFallback']);
    expect(e.usingFallback).toBe(true);
    // Events now come from the adapter; the dead engine is no longer forwarded.
    own.emit('first-segment', { at: 1 });
    adapter.emit('first-segment', { at: 2 });
    expect(firsts).toEqual([2]);
    e.selectQuality('auto');
    expect(adapter.calls).toContain('quality:auto');
  });

  it('network errors do not fall back (the adapter would fail the same way)', async () => {
    const own = fakeEngine('own', createError({ type: 'network', details: 'streamLoadError', fatal: true, recoverable: true }));
    let created = false;
    const e = withAdapterFallback(own, () => {
      created = true;
      return fakeEngine('adapter');
    });
    await expect(e.load()).rejects.toMatchObject({ details: 'streamLoadError' });
    expect(created).toBe(false);
  });

  it('a working pipeline is used as is', async () => {
    const own = fakeEngine('own');
    const e = withAdapterFallback(own, () => fakeEngine('adapter'));
    await e.load();
    expect(e.usingFallback).toBe(false);
    expect(e.formatId).toBe('own');
  });
});
