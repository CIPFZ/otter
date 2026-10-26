// Danmaku settings and state (SPEC §13.2, ADR-012): what the viewer can change in the settings
// page (and @otter-player/preferences keeps), the comment model, and the filters settings imply.

import type { Mode } from './vendor/danmaku/allocate.js';

export type { Mode as DanmakuMode } from './vendor/danmaku/allocate.js';

export interface DanmakuSettings {
  readonly enabled: boolean;
  /** 0.1 .. 1 */
  readonly opacity: number;
  /** Font size factor, 0.5 .. 2. */
  readonly fontScale: number;
  /** Scroll speed factor, 0.5 .. 2 (1: a comment crosses the stage in SCROLL_S seconds). */
  readonly speed: number;
  /** Share of the picture height comments may use: 0.25, 0.5, 0.75 or 1. */
  readonly area: number;
  /** Share of the comments shown, 0 .. 1 (deterministic per comment). */
  readonly density: number;
  readonly hideScroll: boolean;
  readonly hideTop: boolean;
  readonly hideBottom: boolean;
  /** Blocked words; `/pattern/flags` is a regular expression. */
  readonly blocked: readonly string[];
}

export const DEFAULT_DANMAKU: DanmakuSettings = {
  enabled: true,
  opacity: 1,
  fontScale: 1,
  speed: 1,
  area: 1,
  density: 1,
  hideScroll: false,
  hideTop: false,
  hideBottom: false,
  blocked: [],
};

export interface DanmakuStatus {
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  /** Comments loaded (supported modes). */
  readonly count: number;
  /** Elements not loaded: advanced / code comments, malformed ones. */
  readonly skipped: number;
  /** The renderer drawing now, and why it was chosen (ADR-012). */
  readonly renderer: string | null;
  readonly reason: string | null;
  /** The mask in use ('svg: 900 frames', 'webm: 30 fps'), why there is none, or null. */
  readonly mask: string | null;
  /** Renderer decisions, oldest first (last 20), in router.explain()'s step shape. */
  readonly steps: readonly { readonly candidate: string; readonly outcome: 'selected' | 'rejected' | 'failed'; readonly reason: string }[];
}

export interface DanmakuState {
  readonly danmaku: DanmakuSettings;
  readonly danmakuStatus: DanmakuStatus;
}

export const INITIAL_DANMAKU_STATE: DanmakuState = {
  danmaku: DEFAULT_DANMAKU,
  danmakuStatus: { status: 'idle', count: 0, skipped: 0, renderer: null, reason: null, mask: null, steps: [] },
};

/** A comment as given to the engine (parsed lists, `send-danmaku`, the host). */
export interface DanmakuInput {
  /** Media seconds. */
  readonly time: number;
  readonly text: string;
  /** Default `rtl` (scrolling). B站 mode numbers are mapped by the parsers. */
  readonly mode?: Mode;
  /** 0xRRGGBB, default white. */
  readonly color?: number;
  /** px at font scale 1, default 25. */
  readonly size?: number;
  /** The viewer's own: drawn with a border. */
  readonly own?: boolean;
}

export interface DanmakuActionMap {
  'set-danmaku': Partial<DanmakuSettings>;
  /** A comment list: fetched from `url`, or given as `text` (XML / JSON) or `comments`. */
  'load-danmaku': { readonly url?: string; readonly text?: string; readonly comments?: readonly DanmakuInput[] };
  /** The viewer's comment at the current media time (shown at once, marked as own). */
  'send-danmaku': { readonly text: string; readonly mode?: Mode; readonly color?: number };
  'clear-danmaku': Record<string, never>;
  /**
   * A mask over the picture (ADR-012 §6): per-frame SVG (`frames`, or JSON {frames} at `url`), or a
   * WebM with alpha at `url` (`fps`, default 30). Comments are erased where the subject is.
   */
  'load-danmaku-mask': { readonly kind: 'svg' | 'webm'; readonly url?: string; readonly frames?: readonly { readonly time: number; readonly svg: string }[]; readonly fps?: number };
  'clear-danmaku-mask': Record<string, never>;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Settings patched by `patch`, every value in range (a hand-written or stored patch). */
export function mergeSettings(s: DanmakuSettings, patch: Partial<DanmakuSettings>): DanmakuSettings {
  const num = (k: 'opacity' | 'fontScale' | 'speed' | 'area' | 'density', lo: number, hi: number): number => {
    const v = patch[k];
    return typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : s[k];
  };
  const bool = (k: 'enabled' | 'hideScroll' | 'hideTop' | 'hideBottom'): boolean => (typeof patch[k] === 'boolean' ? (patch[k] as boolean) : s[k]);
  return {
    enabled: bool('enabled'),
    opacity: num('opacity', 0.1, 1),
    fontScale: num('fontScale', 0.5, 2),
    speed: num('speed', 0.5, 2),
    area: num('area', 0.25, 1),
    density: num('density', 0, 1),
    hideScroll: bool('hideScroll'),
    hideTop: bool('hideTop'),
    hideBottom: bool('hideBottom'),
    blocked: Array.isArray(patch.blocked) ? patch.blocked.filter((w): w is string => typeof w === 'string' && w !== '') : s.blocked,
  };
}

/** One test per blocked entry: a substring, or `/pattern/flags` (an invalid pattern is a substring). */
export function blockTest(blocked: readonly string[]): (text: string) => boolean {
  const tests = blocked.map((w) => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(w);
    if (m !== null) {
      try {
        const re = new RegExp(m[1] as string, (m[2] as string).replace(/[gy]/g, ''));
        return (t: string) => re.test(t);
      } catch {
        // Not a valid pattern: matched as written.
      }
    }
    return (t: string) => t.includes(w);
  });
  return (text) => tests.some((t) => t(text));
}

/** Deterministic share: comment `index` is kept at density `d` (the same ones at every rebuild). */
export const sampled = (index: number, d: number): boolean => d >= 1 || ((Math.imul(index + 1, 2654435761) >>> 0) / 4294967296 < d);
