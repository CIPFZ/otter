import { describe, expect, it, vi } from 'vitest';
import { createError, createEventBus, type OtterError } from '@otter-player/core';
import { EMPTY_TRACKS, type Engine, type EngineEvents, type TrackList } from '@otter-player/media';
import { withAdapterFallback } from '@otter-player/engine-pipeline';

function fakeEngine(name: string, fail?: OtterError, tracks: TrackList = EMPTY_TRACKS): Engine & { calls: string[]; emit: <E extends keyof EngineEvents>(e: E, p: EngineEvents[E]) => void } {
  const bus = createEventBus<EngineEvents>();
  const calls: string[] = [];
  return {
    formatId: name,
    tracks,
    mms: false,
    calls,
    emit: (e, p) => bus.emit(e, p),
    async load() {
      calls.push('load');
      if (fail !== undefined) throw fail;
    },
    selectQuality: (id) => void calls.push(`quality:${id}`),
    selectTextTrack: (id) => void calls.push(`text:${id}`),
    selectAudioTrack: (id) => void calls.push(`audio:${id}`),
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

  it('ownEngineUnsupported falls back at load and says why', async () => {
    const own = fakeEngine('own', createError({ type: 'media', details: 'ownEngineUnsupported', fatal: true, recoverable: false, message: 'EXT-X-DISCONTINUITY' }));
    const e = withAdapterFallback(own, () => fakeEngine('hls.js'));
    const errors: { details: string; message: string }[] = [];
    e.on('error', (err) => void errors.push({ details: err.details, message: (err as unknown as Error).message }));
    await e.load();
    expect(e.formatId).toBe('hls.js');
    expect(errors).toEqual([{ details: 'pipelineFallback', message: 'own engine does not support this stream: EXT-X-DISCONTINUITY; using the adapter' }]);
  });

  it('runtime: a fatal media error after the start rebuilds once from the position, keeping the user selections', async () => {
    const ownTracks: TrackList = {
      ...EMPTY_TRACKS,
      quality: 'selectable',
      video: [
        { kind: 'video', id: 'v-720', height: 720, bitrate: 3_000_000, selected: true },
        { kind: 'video', id: 'v-360', height: 360, bitrate: 800_000, selected: false },
      ],
      audio: [
        { kind: 'audio', id: 'a-en', language: 'en', selected: false },
        { kind: 'audio', id: 'a-fr', language: 'fr', selected: true },
      ],
      text: [{ kind: 'text', id: 't-de', language: 'de', role: 'subtitles', selected: true }],
    };
    const adapterTracks: TrackList = {
      ...EMPTY_TRACKS,
      quality: 'selectable',
      video: [
        { kind: 'video', id: 'level-0', height: 360, bitrate: 820_000, selected: false },
        { kind: 'video', id: 'level-1', height: 720, bitrate: 2_900_000, selected: true },
      ],
      audio: [
        { kind: 'audio', id: 'audio-0', language: 'en', selected: true },
        { kind: 'audio', id: 'audio-1', language: 'fr', selected: false },
      ],
      text: [{ kind: 'text', id: 'subs-0', language: 'de', role: 'subtitles', selected: false }],
    };
    const own = fakeEngine('own', undefined, ownTracks);
    const adapter = fakeEngine('hls.js', undefined, adapterTracks);
    const media = { currentTime: 42.5, paused: false, play: vi.fn(async () => undefined) } as unknown as HTMLMediaElement;
    const starts: (number | undefined)[] = [];
    const e = withAdapterFallback(
      own,
      (at) => {
        starts.push(at);
        return adapter;
      },
      { media },
    );
    const errors: { details: string; fatal: boolean }[] = [];
    e.on('error', (err) => void errors.push({ details: err.details, fatal: err.fatal }));
    await e.load();
    // The user picked 360p (manual), French audio, German subtitles.
    e.selectQuality('v-360');
    e.selectAudioTrack?.('a-fr');
    e.selectTextTrack?.('t-de');
    own.emit('error', createError({ type: 'media', details: 'bufferAppendError', fatal: true, recoverable: false }));
    await vi.waitFor(() => expect(adapter.calls).toContain('load'));
    await vi.waitFor(() => expect(media.play).toHaveBeenCalled());
    expect(starts).toEqual([42.5]);
    expect(own.calls).toContain('destroy');
    // Not back to auto: the matching level, and the same languages, by the adapter's ids.
    expect(adapter.calls).toEqual(['load', 'quality:level-0', 'text:subs-0', 'audio:audio-1']);
    expect(errors).toEqual([{ details: 'pipelineFallback', fatal: false }]);
    // Once only: a fatal error from the adapter goes to the session.
    adapter.emit('error', createError({ type: 'media', details: 'bufferAppendError', fatal: true, recoverable: false }));
    expect(errors.at(-1)).toEqual({ details: 'bufferAppendError', fatal: true });
  });

  it('runtime: auto stays auto; network errors after the start do not switch', async () => {
    const own = fakeEngine('own');
    let created = 0;
    const e = withAdapterFallback(own, () => {
      created++;
      return fakeEngine('hls.js');
    });
    const errors: string[] = [];
    e.on('error', (err) => void errors.push(err.details));
    await e.load();
    own.emit('error', createError({ type: 'network', details: 'fragLoadError', fatal: true, recoverable: true }));
    expect(created).toBe(0);
    expect(errors).toEqual(['fragLoadError']);
  });
});
