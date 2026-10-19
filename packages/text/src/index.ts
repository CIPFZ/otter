// Text tracks (SPEC §13.1, ADR-005 §4): sidecar WebVTT / SRT (media-captions), IMSC1 / TTML
// (imscJS) and engine in-band cues share one cue model and one renderer positioned on the picture
// rectangle above the chrome's safe area. `createText()` returns the engine-side plugin (tracks,
// loading, selection in the store) and the overlay that draws the active cues.

import { createError, type Plugin, type PluginContext, type QoeHook, type Store, type StoreSlice, type Unsubscribe } from '@otter-player/core';
import type { InbandCues, SidecarTextTrack, Source, TextTrackInfo } from '@otter-player/media';
import type { Insets, Overlay, OverlayHost } from '@otter-player/surface';
import { activeCues, plainCue, type TextCue } from './cue.js';
import { cueArea, DEFAULT_CUE_SETTINGS } from './layout.js';
import { createCueRenderer, type CueRenderer } from './renderer.js';

export interface TextTrackEntry {
  readonly id: string;
  readonly source: 'sidecar' | 'inband';
  readonly role: 'subtitles' | 'captions';
  readonly format: 'vtt' | 'srt' | 'ttml' | 'cea-608';
  readonly language?: string;
  readonly label?: string;
}

/**
 * User caption display settings (CVAA, 47 CFR §79.103(c)): size, character colour and opacity,
 * background colour / opacity, edge style, font. Absent fields keep the skin's --otter-cue-*.
 */
export interface CaptionStyle {
  /** Multiplier of the default size (5% of the picture height). */
  readonly scale?: number;
  readonly color?: string;
  /** 0..1 */
  readonly opacity?: number;
  readonly background?: string;
  /** Background opacity, 0..1. */
  readonly backgroundOpacity?: number;
  readonly edge?: 'none' | 'shadow' | 'outline' | 'raised' | 'depressed';
  readonly font?: 'default' | 'serif' | 'monospace' | 'casual';
}

export interface TextState {
  readonly textTracks: readonly TextTrackEntry[];
  /** Selected track id, null when captions are off. */
  readonly textTrack: string | null;
  readonly textStatus: 'idle' | 'loading' | 'ready' | 'error';
  readonly captionStyle: CaptionStyle;
}

export const INITIAL_TEXT_STATE: TextState = { textTracks: [], textTrack: null, textStatus: 'idle', captionStyle: {} };
export const TEXT_SLICE: StoreSlice<TextState> = { id: 'text', initialState: INITIAL_TEXT_STATE };

/**
 * `toggle-captions` shares name and payload with InputActionMap in @otter-player/input;
 * `set-text-track` is handled by the media plugin (which in-band track the engine delivers).
 */
export interface TextActionMap {
  'select-text-track': { readonly id: string | null };
  'toggle-captions': Record<string, never>;
  'set-text-track': { readonly id: string | null };
  /** Merges into the caption style; a field set to null returns to the skin default. */
  'set-caption-style': { readonly [K in keyof CaptionStyle]?: CaptionStyle[K] | null };
}

export interface TextOptions {
  /** `custom` (default): Otter's renderer. The native TextTrack path arrives with presentation (M3). */
  readonly mode?: 'custom';
  /** Engine in-band cues (the media plugin); without it only sidecar tracks are offered. */
  readonly inband?: { onTextCues(h: (cues: InbandCues) => void): Unsubscribe };
  /** Cues kept per in-band track (live streams never end); oldest dropped first. */
  readonly maxInbandCues?: number;
  /** localStorage key that keeps the caption style and the last caption language across visits (CVAA retention); null disables. */
  readonly persistKey?: string | null;
  /** Injectable for tests. */
  readonly fetch?: (url: string) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;
}

export interface TextController {
  readonly plugin: Plugin<TextHostState, TextActionMap>;
  readonly overlay: Overlay;
  /** Cues of a track (sidecar after loading, in-band as they arrive). */
  cues(trackId: string): readonly TextCue[];
}

const formatOf = (t: SidecarTextTrack): 'vtt' | 'srt' | 'ttml' =>
  t.format ?? (/\.srt(\?|#|$)/i.test(t.src) ? 'srt' : /\.(ttml|dfxp|xml)(\?|#|$)/i.test(t.src) ? 'ttml' : 'vtt');

/** Media state the plugin reads when present (MediaState provides both). */
type TextHostState = TextState & {
  readonly source?: Source | null;
  readonly tracks?: { readonly text: readonly TextTrackInfo[] };
};

const INBAND = 'inband:';

export function createText(options: TextOptions = {}): TextController {
  type S = TextHostState;
  const maxInband = options.maxInbandCues ?? 2000;
  const doFetch = options.fetch ?? ((url: string) => fetch(url));
  const cueStore = new Map<string, readonly TextCue[]>();
  const sidecars = new Map<string, SidecarTextTrack>();
  let store: Store<S, TextActionMap> | undefined;
  let qoe: QoeHook | undefined;
  let offs: Unsubscribe[] = [];
  let lastSelected: string | null = null;
  let sidecarEntries: TextTrackEntry[] = [];
  let inbandEntries: TextTrackEntry[] = [];
  const inbandCues = new Map<string, Map<string, TextCue>>();
  let generation = 0;
  let changed = (): void => undefined;

  const state = (): Readonly<S> => (store as Store<S, TextActionMap>).getState();

  const persistKey = options.persistKey === undefined ? 'otter:caption-style' : options.persistKey;
  const storage = (): Storage | undefined => {
    try {
      return persistKey === null || typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch {
      // Sandboxed iframes and some privacy modes throw on access.
      return undefined;
    }
  };
  /** Retained across visits: the style, and the caption language (null = the user turned captions off). */
  interface Saved {
    readonly style?: CaptionStyle;
    readonly language?: string | null;
  }
  let saved: Saved = {};
  const restore = (): Saved => {
    try {
      const raw = storage()?.getItem(persistKey as string);
      const parsed: unknown = raw == null ? undefined : JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Saved) : {};
    } catch {
      return {};
    }
  };
  const persist = (language?: string | null): void => {
    const lang = language === undefined ? saved.language : language;
    saved = lang === undefined ? { style: state().captionStyle } : { style: state().captionStyle, language: lang };
    try {
      storage()?.setItem(persistKey as string, JSON.stringify(saved));
    } catch {
      // Quota or privacy mode: the settings still apply for this session.
    }
  };

  const load = async (id: string): Promise<void> => {
    const track = sidecars.get(id);
    if (track === undefined || cueStore.has(id)) {
      store?.setState({ textStatus: 'ready' } as Partial<S>);
      return;
    }
    const gen = generation;
    store?.setState({ textStatus: 'loading' } as Partial<S>);
    try {
      const res = await doFetch(track.src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      const format = formatOf(track);
      const cues =
        format === 'ttml'
          ? (await import('./ttml.js')).parseTtml(body, DEFAULT_CUE_SETTINGS, id)
          : (await import('./vtt.js')).parseCaptions(body, format, id).then((r) => r.cues);
      const parsed = await cues;
      if (gen !== generation) return;
      cueStore.set(id, parsed);
      if (state().textTrack === id) store?.setState({ textStatus: 'ready' } as Partial<S>);
      changed();
    } catch (err) {
      if (gen !== generation) return;
      if (state().textTrack === id) store?.setState({ textStatus: 'error' } as Partial<S>);
      qoe?.emit('error', {
        error: createError({ type: 'network', details: 'textTrackLoadFailed', fatal: false, recoverable: true, message: String(err), cause: err }),
        fallback: [],
      });
    }
  };

  const publishTracks = (): void => {
    store?.setState({ textTracks: [...sidecarEntries, ...inbandEntries] } as Partial<S>);
  };

  const select = (id: string | null, byUser = true): void => {
    const known = id === null || state().textTracks.some((t) => t.id === id);
    if (!known) return;
    if (byUser) persist(id === null ? null : (state().textTracks.find((t) => t.id === id)?.language ?? saved.language ?? null));
    if (id !== null) lastSelected = id;
    const inband = id !== null && id.startsWith(INBAND);
    store?.setState({ textTrack: id, textStatus: id === null ? 'idle' : inband ? 'ready' : state().textStatus } as Partial<S>);
    // The engine only delivers cues for the in-band track it was told about.
    store?.dispatch('set-text-track', { id: inband ? id.slice(INBAND.length) : null });
    if (id !== null && !inband) void load(id);
    changed();
  };

  /** In-band tracks come from the media track list (engine subtitle playlists, CEA-608 channels). */
  const onEngineTracks = (text: readonly TextTrackInfo[] | undefined): void => {
    inbandEntries = (text ?? []).map((t) => ({
      id: `${INBAND}${t.id}`,
      source: 'inband',
      role: t.role === 'captions' ? 'captions' : 'subtitles',
      format: t.format === 'cea-608' ? 'cea-608' : t.format === 'ttml' ? 'ttml' : 'vtt',
      ...(t.language === undefined ? {} : { language: t.language }),
      ...(t.label === undefined ? {} : { label: t.label }),
    }));
    publishTracks();
    const current = state().textTrack;
    if (current !== null && current.startsWith(INBAND) && !inbandEntries.some((e) => e.id === current)) select(null, false);
    // Remembered language available in-band only (no sidecar chosen yet): turn it on.
    if (state().textTrack === null && typeof saved.language === 'string') {
      const match = inbandEntries.find((e) => e.language === saved.language);
      if (match !== undefined) select(match.id, false);
    }
  };

  let vttNodes: ((text: string) => Promise<TextCue['nodes']>) | undefined;
  const onInbandCues = async ({ trackId, cues }: InbandCues): Promise<void> => {
    const id = `${INBAND}${trackId}`;
    const gen = generation;
    // Engine cue text may carry WebVTT markup (<i>, <c.yellow>); same tokenizer as sidecar files.
    if (vttNodes === undefined && cues.some((c) => c.text.includes('<'))) vttNodes = (await import('./vtt.js')).vttNodes;
    if (gen !== generation) return;
    let map = inbandCues.get(id);
    if (map === undefined) inbandCues.set(id, (map = new Map()));
    for (const c of cues) {
      const key = `${id}:${c.id}`;
      if (map.has(key)) continue;
      const settings = {
        ...(c.line === undefined ? {} : { line: c.line }),
        ...(c.snapToLines === undefined ? {} : { snapToLines: c.snapToLines }),
        ...(c.lineAlign === undefined ? {} : { lineAlign: c.lineAlign }),
        ...(c.position === undefined ? {} : { position: c.position }),
        ...(c.positionAlign === undefined ? {} : { positionAlign: c.positionAlign }),
        ...(c.size === undefined ? {} : { size: c.size }),
        ...(c.align === undefined ? {} : { align: c.align }),
      };
      const cue = plainCue(key, c.startTime, c.endTime, c.text, settings);
      map.set(key, vttNodes !== undefined && c.text.includes('<') ? { ...cue, nodes: await vttNodes(c.text) } : cue);
    }
    if (gen !== generation) return;
    if (map.size > maxInband) {
      const keep = [...map.values()].sort((a, b) => a.endTime - b.endTime).slice(-maxInband);
      map.clear();
      for (const c of keep) map.set(c.id, c);
    }
    cueStore.set(id, [...map.values()]);
    if (state().textTrack === id) changed();
  };

  /** New source: its sidecar tracks replace the previous ones; `default` is selected. */
  const onSource = (source: Source | null | undefined): void => {
    generation++;
    sidecars.clear();
    cueStore.clear();
    inbandCues.clear();
    const tracks = source?.textTracks ?? [];
    const entries: TextTrackEntry[] = tracks.map((t, i) => {
      const id = `sidecar:${i}`;
      sidecars.set(id, t);
      return {
        id,
        source: 'sidecar',
        role: t.role ?? 'subtitles',
        format: formatOf(t),
        ...(t.language === undefined ? {} : { language: t.language }),
        ...(t.label === undefined ? {} : { label: t.label }),
      };
    });
    sidecarEntries = entries;
    store?.setState({ textTracks: [...entries, ...inbandEntries], textTrack: null, textStatus: 'idle' } as Partial<S>);
    lastSelected = null;
    // The user's retained choice beats the host's default: their language, or captions off.
    const remembered = saved.language === undefined ? -2 : saved.language === null ? -1 : tracks.findIndex((t) => t.language === saved.language);
    const preferred = remembered >= 0 || saved.language === null ? remembered : tracks.findIndex((t) => t.default === true);
    if (preferred >= 0) select(`sidecar:${preferred}`, false);
    changed();
  };

  const plugin: TextController['plugin'] = {
    id: 'text',
    install(ctx: PluginContext<S, TextActionMap>) {
      store = ctx.store;
      qoe = ctx.qoe;
      offs = [
        ctx.store.handle('select-text-track', ({ id }) => select(id)),
        ctx.store.handle('set-caption-style', (patch) => {
          const next: Record<string, unknown> = { ...state().captionStyle };
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === undefined) delete next[k];
            else next[k] = v;
          }
          store?.setState({ captionStyle: next as CaptionStyle } as Partial<S>);
          persist(undefined);
          changed();
        }),
        ctx.store.handle('toggle-captions', () => {
          const s = state();
          if (s.textTrack !== null) select(null);
          else select(lastSelected ?? s.textTracks[0]?.id ?? null);
        }),
        ctx.store.select(
          (s) => s.source,
          (source) => onSource(source),
        ),
        ctx.store.select(
          (s) => s.tracks?.text,
          (text) => onEngineTracks(text),
        ),
        ...(options.inband === undefined ? [] : [options.inband.onTextCues((c) => void onInbandCues(c))]),
      ];
      saved = restore();
      if (saved.style !== undefined) store.setState({ captionStyle: saved.style } as Partial<S>);
      if (state().source != null) onSource(state().source);
      onEngineTracks(state().tracks?.text);
    },
    uninstall() {
      for (const off of offs) off();
      offs = [];
      generation++;
      store = undefined;
      qoe = undefined;
    },
  };

  let host: OverlayHost | undefined;
  let renderer: CueRenderer | undefined;
  let safe: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let mediaTime = 0;
  let hostOffs: Unsubscribe[] = [];

  const draw = (): void => {
    if (host === undefined || renderer === undefined) return;
    const view = host.store.getState() as Partial<TextState>;
    const id = view.textTrack ?? null;
    const cues = id === null ? [] : activeCues(cueStore.get(id) ?? [], mediaTime);
    const rect = host.contentRect;
    const area = cueArea(
      { left: rect.x, top: rect.y, width: rect.width, height: rect.height },
      { width: host.root.clientWidth, height: host.root.clientHeight },
      safe.bottom,
    );
    renderer.style(view.captionStyle ?? {});
    renderer.render(cues, area, mediaTime);
  };
  changed = draw;

  const overlay: Overlay = {
    id: 'text',
    // Provisional stacking order inside the overlay layer; settled with the player shell in M1.
    zIndex: 200,
    mount(h) {
      host = h;
      renderer = createCueRenderer(h.root);
      hostOffs = [h.onContentRectChange(draw), h.store.subscribe(draw)];
      draw();
    },
    tick(_now, time) {
      mediaTime = time;
      draw();
    },
    setSafeArea(insets) {
      safe = insets;
      draw();
    },
    destroy() {
      for (const off of hostOffs) off();
      hostOffs = [];
      renderer?.destroy();
      renderer = undefined;
      host = undefined;
    },
  };

  return { plugin, overlay, cues: (id) => cueStore.get(id) ?? [] };
}

/** The overlay alone (cues come from a `createText()` plugin sharing the same controller). */
export function createTextOverlay(options: TextOptions = {}): Overlay {
  return createText(options).overlay;
}

export { activeCues, cueText, plainCue, type CueNode, type CueNodeType, type TextCue } from './cue.js';
export {
  cueArea,
  DEFAULT_CUE_SETTINGS,
  horizontalLayout,
  layoutCues,
  type Area,
  type Box,
  type CueAlign,
  type CueSettings,
  type HorizontalLayout,
  type LayoutItem,
  type PlacedCue,
  type PositionAlign,
  type RegionSettings,
} from './layout.js';
export { createCueRenderer, type CueRenderer } from './renderer.js';
export type { ParsedCaptions, SidecarFormat } from './vtt.js';
export type { Cea608Channel, Cea608Decoder } from './cea608.js';

/**
 * CEA-608 decoder for pipelines that extract cc_data themselves (M3 own pipeline). Loaded on
 * demand: the parser's tables are module-level and only needed once captions show up.
 */
export const loadCea608 = (): Promise<typeof import('./cea608.js')> => import('./cea608.js');
