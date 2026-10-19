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

export interface TextState {
  readonly textTracks: readonly TextTrackEntry[];
  /** Selected track id, null when captions are off. */
  readonly textTrack: string | null;
  readonly textStatus: 'idle' | 'loading' | 'ready' | 'error';
}

export const INITIAL_TEXT_STATE: TextState = { textTracks: [], textTrack: null, textStatus: 'idle' };
export const TEXT_SLICE: StoreSlice<TextState> = { id: 'text', initialState: INITIAL_TEXT_STATE };

/**
 * `toggle-captions` shares name and payload with InputActionMap in @otter-player/input;
 * `set-text-track` is handled by the media plugin (which in-band track the engine delivers).
 */
export interface TextActionMap {
  'select-text-track': { readonly id: string | null };
  'toggle-captions': Record<string, never>;
  'set-text-track': { readonly id: string | null };
}

export interface TextOptions {
  /** `custom` (default): Otter's renderer. The native TextTrack path arrives with presentation (M3). */
  readonly mode?: 'custom';
  /** Engine in-band cues (the media plugin); without it only sidecar tracks are offered. */
  readonly inband?: { onTextCues(h: (cues: InbandCues) => void): Unsubscribe };
  /** Cues kept per in-band track (live streams never end); oldest dropped first. */
  readonly maxInbandCues?: number;
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

  const select = (id: string | null): void => {
    const known = id === null || state().textTracks.some((t) => t.id === id);
    if (!known) return;
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
    if (current !== null && current.startsWith(INBAND) && !inbandEntries.some((e) => e.id === current)) select(null);
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
    const preferred = tracks.findIndex((t) => t.default === true);
    if (preferred >= 0) select(`sidecar:${preferred}`);
    changed();
  };

  const plugin: TextController['plugin'] = {
    id: 'text',
    install(ctx: PluginContext<S, TextActionMap>) {
      store = ctx.store;
      qoe = ctx.qoe;
      offs = [
        ctx.store.handle('select-text-track', ({ id }) => select(id)),
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
