// Viewer preferences (ADR-011 batch 3, SPEC §19 B 站式弹幕站): what the viewer chose is
// remembered across visits through a storage adapter the host can replace (default:
// localStorage under a prefix). Only these are kept: the video codec order, the quality (as a
// picture height, so it carries over between streams), the audio and subtitle languages, the
// volume and the playback speed. Never the playback position.
//
// Importing touches no global (SSR-safe): the default adapter reaches localStorage only when it
// reads or writes, and gives up quietly where it throws (sandboxed iframes, privacy modes).

import type { Plugin, PluginContext, Store } from '@otter-player/core';

export type CodecFamily = 'av1' | 'hevc' | 'vp9' | 'h264';
const FAMILIES: readonly string[] = ['av1', 'hevc', 'vp9', 'h264'];

/** Where preferences live. Strings only, like Web Storage; may be synchronous or not. */
export interface PreferenceStorage {
  get(key: string): string | null | undefined | Promise<string | null | undefined>;
  set(key: string, value: string): void | Promise<void>;
}

/** The part of Web Storage the default adapter uses (no DOM lib: SSR / Workers type-check too). */
interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage under `prefix` (default `otter:`), looked up on each access. */
export function localStoragePreferences(prefix = 'otter:'): PreferenceStorage {
  const storage = (): WebStorage | undefined => {
    try {
      return (globalThis as { localStorage?: WebStorage }).localStorage;
    } catch {
      return undefined;
    }
  };
  return {
    get(key) {
      try {
        return storage()?.getItem(prefix + key);
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        storage()?.setItem(prefix + key, value);
      } catch {
        // Quota or privacy mode: the choice still applies for this visit.
      }
    },
  };
}

/** What is remembered. Absent: nothing chosen yet. */
export interface Preferences {
  readonly codecs?: readonly CodecFamily[];
  /** A picture height, or `auto`. */
  readonly quality?: number | 'auto';
  readonly audioLanguage?: string;
  /** A subtitle language, or `off`. */
  readonly textLanguage?: string;
  /** 0..1 */
  readonly volume?: number;
  readonly playbackRate?: number;
}

/** Keeps what parses and is in range; anything else is dropped (a hand-edited or old entry). */
export function sanitize(raw: unknown): Preferences {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof Preferences]: Preferences[K] } = {};
  if (Array.isArray(r['codecs'])) {
    const codecs = r['codecs'].filter((c): c is CodecFamily => typeof c === 'string' && FAMILIES.includes(c));
    if (codecs.length > 0) out.codecs = [...new Set(codecs)];
  }
  if (r['quality'] === 'auto' || (typeof r['quality'] === 'number' && Number.isInteger(r['quality']) && r['quality'] > 0)) out.quality = r['quality'];
  if (typeof r['audioLanguage'] === 'string' && r['audioLanguage'] !== '') out.audioLanguage = r['audioLanguage'];
  if (typeof r['textLanguage'] === 'string' && r['textLanguage'] !== '') out.textLanguage = r['textLanguage'];
  if (typeof r['volume'] === 'number' && r['volume'] >= 0 && r['volume'] <= 1) out.volume = r['volume'];
  if (typeof r['playbackRate'] === 'number' && r['playbackRate'] >= 0.25 && r['playbackRate'] <= 4) out.playbackRate = r['playbackRate'];
  return out;
}

export interface PreferencesOptions {
  /** Default localStoragePreferences(). */
  readonly storage?: PreferenceStorage;
  /** Key inside the storage (default `preferences`): one JSON entry. */
  readonly key?: string;
}

interface Track {
  readonly id: string;
  readonly language?: string | undefined;
  readonly height?: number | undefined;
  readonly selected?: boolean | undefined;
}

/** The media and text state this reads (MediaState, TextState). */
export interface PreferencesState {
  readonly source?: object | null;
  readonly tracks?: { readonly video: readonly Track[]; readonly audio: readonly Track[] };
  readonly quality?: string;
  readonly volume?: number;
  readonly playbackRate?: number;
  readonly textTracks?: readonly Track[];
  readonly textTrack?: string | null;
}

/** The actions this watches and dispatches (MediaActionMap, TextActionMap). */
export interface PreferencesActionMap {
  'set-codec-preference': { readonly order: readonly CodecFamily[] | null };
  'select-quality': { readonly id: string };
  'select-audio-track': { readonly id: string };
  'select-text-track': { readonly id: string | null };
  'set-volume': { readonly volume: number };
  'volume-by': { readonly delta: number };
  'set-playback-rate': { readonly rate: number };
}

export interface PreferencesPlugin<S extends PreferencesState, A extends PreferencesActionMap> extends Plugin<S, A> {
  /** What is remembered now (after restore). */
  current(): Preferences;
  /** Forgets everything stored. */
  clear(): Promise<void>;
}

/** Track of `tracks` closest to `height` from below (the highest when all are taller). */
function byHeight(tracks: readonly Track[], height: number): Track | undefined {
  const sized = tracks.filter((t) => (t.height ?? 0) > 0);
  const below = sized.filter((t) => (t.height as number) <= height).sort((a, b) => (b.height as number) - (a.height as number));
  return below[0] ?? [...sized].sort((a, b) => (a.height as number) - (b.height as number))[0];
}

const sameLanguage = (a: string | undefined, b: string): boolean => a !== undefined && (a === b || a.split('-')[0] === b.split('-')[0]);

/**
 * Remembers the viewer's choices (user actions only: the engine's ABR switches, a long-press 2x
 * or a live catch-up are not choices) and applies them: volume, speed and codec order at start
 * (the codec order from the next load), quality and languages once per source when its tracks
 * are known. Install after the media and text plugins (it dispatches their actions).
 */
export function createPreferencesPlugin<S extends PreferencesState, A extends PreferencesActionMap>(options: PreferencesOptions = {}): PreferencesPlugin<S, A> {
  const storage = options.storage ?? localStoragePreferences();
  const key = options.key ?? 'preferences';
  let prefs: Preferences = {};
  let offs: (() => void)[] = [];
  let restoring = false;

  const save = (patch: Partial<{ -readonly [K in keyof Preferences]: Preferences[K] | undefined }>): void => {
    if (restoring) return;
    const next: Record<string, unknown> = { ...prefs, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    prefs = sanitize(next);
    void Promise.resolve(storage.set(key, JSON.stringify(prefs))).catch(() => undefined);
  };

  return {
    id: 'preferences',
    deps: ['media'],
    current: () => prefs,
    async clear() {
      prefs = {};
      await storage.set(key, '{}');
    },
    async install(ctx: PluginContext<S, A>) {
      try {
        const raw = await storage.get(key);
        prefs = raw == null ? {} : sanitize(JSON.parse(raw));
      } catch {
        prefs = {};
      }
      const store = ctx.store as unknown as Store<PreferencesState, PreferencesActionMap>;
      const state = (): Readonly<PreferencesState> => store.getState();
      const dispatch = <K extends keyof PreferencesActionMap>(type: K, payload: PreferencesActionMap[K]): void => {
        restoring = true;
        try {
          store.dispatch(type, payload);
        } finally {
          restoring = false;
        }
      };

      // Choices, from the user's actions (this plugin runs after the media plugin's handler).
      offs = [
        store.handle('set-codec-preference', ({ order }) => save({ codecs: order === null ? undefined : [...order] })),
        store.handle('select-quality', ({ id }) => {
          if (id === 'auto') return save({ quality: 'auto' });
          const h = state().tracks?.video.find((t) => t.id === id)?.height;
          if (h !== undefined && h > 0) save({ quality: h });
        }),
        store.handle('select-audio-track', ({ id }) => {
          const lang = state().tracks?.audio.find((t) => t.id === id)?.language;
          if (lang !== undefined) save({ audioLanguage: lang });
        }),
        store.handle('select-text-track', ({ id }) => {
          if (id === null) return save({ textLanguage: 'off' });
          const lang = state().textTracks?.find((t) => t.id === id)?.language;
          if (lang !== undefined) save({ textLanguage: lang });
        }),
        store.handle('set-volume', () => save({ volume: state().volume })),
        store.handle('volume-by', () => save({ volume: state().volume })),
        store.handle('set-playback-rate', ({ rate }) => save({ playbackRate: rate })),
      ];

      // At start: volume, speed, codec order (the session applies it to the next load).
      if (prefs.volume !== undefined) dispatch('set-volume', { volume: prefs.volume });
      if (prefs.playbackRate !== undefined) dispatch('set-playback-rate', { rate: prefs.playbackRate });
      if (prefs.codecs !== undefined) dispatch('set-codec-preference', { order: prefs.codecs });

      // Per source, once its tracks are known: quality, audio language, subtitle language.
      let applied: { source: object | null | undefined; quality: boolean; audio: boolean; text: boolean } = { source: undefined, quality: false, audio: false, text: false };
      const apply = (s: Readonly<PreferencesState>): void => {
        if (s.source !== applied.source) applied = { source: s.source, quality: false, audio: false, text: false };
        if (s.source == null) return;
        const video = s.tracks?.video ?? [];
        if (!applied.quality && video.length > 0) {
          applied.quality = true;
          const q = prefs.quality;
          const t = typeof q === 'number' && video.length > 1 && s.quality === 'auto' ? byHeight(video, q) : undefined;
          if (t !== undefined) dispatch('select-quality', { id: t.id });
        }
        const audio = s.tracks?.audio ?? [];
        if (!applied.audio && audio.length > 0) {
          applied.audio = true;
          const lang = prefs.audioLanguage;
          const t = lang === undefined ? undefined : audio.find((a) => sameLanguage(a.language, lang));
          if (t !== undefined && t.selected !== true) dispatch('select-audio-track', { id: t.id });
        }
        const texts = s.textTracks ?? [];
        if (!applied.text && texts.length > 0) {
          applied.text = true;
          const lang = prefs.textLanguage;
          const t = lang === undefined || lang === 'off' ? undefined : texts.find((x) => sameLanguage(x.language, lang));
          if (t !== undefined && s.textTrack !== t.id) dispatch('select-text-track', { id: t.id });
        }
      };
      offs.push(store.subscribe(apply));
      apply(state());
    },
    uninstall() {
      for (const off of offs) off();
      offs = [];
    },
  };
}
