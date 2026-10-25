import { describe, expect, it } from 'vitest';
import { createCore, type Plugin, type PluginContext, type Store } from '@otter-player/core';
import { createPreferencesPlugin, localStoragePreferences, sanitize, type PreferencesActionMap, type PreferencesState, type PreferenceStorage } from '@otter-player/preferences';

type S = PreferencesState & { codecPreference: readonly string[] | null };
const memory = (initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } => {
  const data = { ...initial };
  return { data, get: (k) => data[k] ?? null, set: (k, v) => void (data[k] = v) };
};

/** A stand-in for the media and text plugins: the actions set state like they do. */
const fakeMedia = (): Plugin<S, PreferencesActionMap> => ({
  id: 'media',
  install(ctx: PluginContext<S, PreferencesActionMap>) {
    const s = ctx.store as Store<S, PreferencesActionMap>;
    s.handle('set-volume', ({ volume }) => s.setState({ volume }));
    s.handle('volume-by', ({ delta }) => s.setState({ volume: Math.min(1, Math.max(0, (s.getState().volume ?? 1) + delta)) }));
    s.handle('set-playback-rate', ({ rate }) => s.setState({ playbackRate: rate }));
    s.handle('select-quality', ({ id }) => s.setState({ quality: id }));
    s.handle('set-codec-preference', ({ order }) => s.setState({ codecPreference: order }));
    s.handle('select-audio-track', ({ id }) => {
      const t = s.getState().tracks;
      if (t !== undefined) s.setState({ tracks: { ...t, audio: t.audio.map((a) => ({ ...a, selected: a.id === id })) } });
    });
    s.handle('select-text-track', ({ id }) => s.setState({ textTrack: id }));
  },
  uninstall: () => undefined,
});

const INITIAL: S = { source: null, tracks: { video: [], audio: [] }, quality: 'auto', volume: 1, playbackRate: 1, textTracks: [], textTrack: null, codecPreference: null };
const tracks = {
  video: [
    { id: 'v0', height: 1080 },
    { id: 'v1', height: 720 },
    { id: 'v2', height: 360 },
  ],
  audio: [
    { id: 'a0', language: 'en', selected: true },
    { id: 'a1', language: 'fr-CA', selected: false },
  ],
};
const texts = [
  { id: 't0', language: 'en' },
  { id: 't1', language: 'de' },
];

async function player(storage: PreferenceStorage) {
  const prefs = createPreferencesPlugin<S, PreferencesActionMap>({ storage });
  const core = createCore<S, PreferencesActionMap>({ slices: [{ id: 'state', initialState: INITIAL }], plugins: [prefs, fakeMedia()] });
  await core.start();
  return { core, prefs, store: core.store as Store<S, PreferencesActionMap> };
}

describe('preferences (ADR-011 batch 3)', () => {
  it('remembers user choices in one JSON entry; never the position', async () => {
    const storage = memory();
    const { store } = await player(storage);
    store.setState({ source: {}, tracks, textTracks: texts });
    store.dispatch('set-volume', { volume: 0.4 });
    store.dispatch('volume-by', { delta: -0.1 });
    store.dispatch('set-playback-rate', { rate: 1.5 });
    store.dispatch('select-quality', { id: 'v1' });
    store.dispatch('select-audio-track', { id: 'a1' });
    store.dispatch('select-text-track', { id: 't1' });
    store.dispatch('set-codec-preference', { order: ['hevc', 'h264'] });
    const saved = JSON.parse(storage.data['preferences'] as string) as Record<string, unknown>;
    expect(saved).toEqual({ volume: expect.closeTo(0.3, 5) as unknown, playbackRate: 1.5, quality: 720, audioLanguage: 'fr-CA', textLanguage: 'de', codecs: ['hevc', 'h264'] });
    expect(Object.keys(saved)).not.toContain('currentTime');
    store.dispatch('select-text-track', { id: null });
    store.dispatch('select-quality', { id: 'auto' });
    expect(JSON.parse(storage.data['preferences'] as string)).toMatchObject({ textLanguage: 'off', quality: 'auto' });
  });

  it('applies them on the next visit: at start, then per source once its tracks are known', async () => {
    const storage = memory({ preferences: JSON.stringify({ volume: 0.3, playbackRate: 1.25, codecs: ['vp9'], quality: 800, audioLanguage: 'fr', textLanguage: 'de' }) });
    const { store } = await player(storage);
    expect(store.getState()).toMatchObject({ volume: 0.3, playbackRate: 1.25, codecPreference: ['vp9'] });
    store.setState({ source: {}, tracks, textTracks: texts });
    // 800 lines: the highest at or below it; French matches fr-CA; German subtitles on.
    expect(store.getState()).toMatchObject({ quality: 'v1', textTrack: 't1' });
    expect(store.getState().tracks?.audio.find((a) => a.selected)?.id).toBe('a1');
    // Restoring is not a new choice; a user choice on this source is not overridden.
    store.dispatch('select-quality', { id: 'v2' });
    store.setState({ tracks: { ...tracks } });
    expect(store.getState().quality).toBe('v2');
    // A new source gets the remembered (now 360) quality again.
    store.setState({ source: {}, quality: 'auto', tracks: { ...tracks } });
    expect(store.getState().quality).toBe('v2');
  });

  it('drops what does not parse or is out of range', () => {
    expect(sanitize({ volume: 3, playbackRate: 0, quality: -1, codecs: ['av1', 'mpeg2', 'av1'], audioLanguage: '', textLanguage: 7 })).toEqual({ codecs: ['av1'] });
    expect(sanitize('x')).toEqual({});
  });

  it('a broken entry or a failing storage starts empty and still plays', async () => {
    const throwing: PreferenceStorage = {
      get: () => {
        throw new Error('denied');
      },
      set: () => Promise.reject(new Error('quota')),
    };
    const { store, prefs } = await player(throwing);
    store.dispatch('set-volume', { volume: 0.5 });
    expect(prefs.current()).toEqual({ volume: 0.5 });
    const broken = await player(memory({ preferences: '{not json' }));
    expect(broken.prefs.current()).toEqual({});
  });

  it('the default adapter touches no global until used, and survives a missing or throwing localStorage', () => {
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    delete g.localStorage;
    const s = localStoragePreferences('test:');
    expect(s.get('k')).toBeUndefined();
    s.set('k', 'v');
    const map = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    s.set('k', 'v');
    expect(map.get('test:k')).toBe('v');
    expect(s.get('k')).toBe('v');
    g.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(s.get('k')).toBeUndefined();
    expect(() => s.set('k', 'v')).not.toThrow();
    if (before === undefined) delete g.localStorage;
    else g.localStorage = before;
  });
});
