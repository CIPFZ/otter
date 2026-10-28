// Danmaku engine (SPEC §13.2, ADR-012): comments over the picture, drawn from the shared overlay
// tick (one rAF with captions, SPEC §3 rule 4). The timeline is media time: a comment's position
// is a function of (media time - its time), so pause freezes it, playback rate scales it, a seek
// rebuilds the stage at the new time, and a hidden page draws nothing. Tracks from `danmaku`
// (weizhenye), parsers from CommentCoreLibrary (vendor/, L3). Comment lists load on demand
// (parse.ts); WebGL and the Worker renderer are on-demand chunks too (ADR-012).
//
// Not in scope (M5): advanced comments (mode 7 / 8 / 9), CSS tracks, server-side masks, live
// WebSocket comments.

import type { Plugin, PluginContext, Store, StoreSlice, Unsubscribe } from '@otter-player/core';
import type { Overlay, OverlayHost } from '@otter-player/surface';
import type { MaskFrame, MaskSource } from './mask.js';
import { decide, rendererBlocked, type FrameSample, type RendererKind } from './policy.js';
import { createCanvasRenderer, font, lineHeight, paintText, type Comment, type DanmakuRenderer } from './renderer.js';
import {
  blockTest,
  INITIAL_DANMAKU_STATE,
  mergeSettings,
  sampled,
  type DanmakuActionMap,
  type DanmakuInput,
  type DanmakuSettings,
  type DanmakuState,
} from './settings.js';
import { resetSpace, type Stage } from './vendor/danmaku/allocate.js';
import { frame, rebuild, type FrameHooks, type FrameState } from './vendor/danmaku/frame.js';

export * from './settings.js';
export type { Comment, DanmakuRenderer } from './renderer.js';
export { POLICY as RENDERER_POLICY, type FrameSample, type RendererKind } from './policy.js';

/** Seconds a scrolling comment takes across the stage at speed 1 (B站: about 8 s). */
export const SCROLL_S = 8;
/** Seconds a top / bottom comment stays. */
export const FIXED_S = 4;
/** One display frame at 60 Hz, ms. */
const DISPLAY_FRAME_MS = 16.7;

export const DANMAKU_SLICE: StoreSlice<DanmakuState> = { id: 'danmaku', initialState: INITIAL_DANMAKU_STATE };

/** Media state the engine reads when present (MediaState). */
export interface DanmakuHostState extends DanmakuState {
  readonly source?: object | null;
  readonly paused?: boolean;
  readonly seeking?: boolean;
  readonly waiting?: boolean;
  readonly ended?: boolean;
  readonly playbackRate?: number;
}

export interface DanmakuOptions {
  /** Injectable for tests; default fetch. */
  readonly fetch?: (url: string) => Promise<Response>;
  /**
   * `auto` (default): Canvas 2D, WebGL when the stage is dense, the Worker when the page keeps
   * frames late (ADR-012 §5). A fixed kind falls back to Canvas 2D where it cannot run.
   */
  readonly renderer?: 'auto' | RendererKind;
}

/** What the engine is doing, for tests and diagnostics. */
export interface DanmakuInspection {
  /** Media time of the last frame drawn. */
  readonly time: number;
  /** Media time of the picture the last frame was drawn for (the mask lookup), and the mask frame used. */
  readonly frameTime: number;
  /** Seconds `frameTime` was drawn ahead of the picture (one display frame + renderer latency, while playing). */
  readonly lead: number;
  readonly maskIndex: number | null;
  /** Frames drawn while the mask frame was not decoded yet (drawn unmasked). */
  readonly maskMissing: number;
  /** Frames drawn (none while paused and unchanged, hidden, or disabled). */
  readonly frames: number;
  readonly renderer: string | null;
  /** Main-thread ms per drawn frame (placement + renderer), over the last drawn frames: p50 / p95. */
  readonly cost: { readonly p50: number; readonly p95: number };
  /** The Worker's own frame interval p95 (ms) over its last 600 frames; null for main-thread renderers. */
  readonly ownFrameP95: number | null;
  readonly stage: { readonly width: number; readonly height: number; readonly duration: number };
  readonly running: readonly { readonly text: string; readonly mode: string; readonly time: number; readonly x: number; readonly y: number; readonly width: number }[];
}

export interface DanmakuController {
  readonly plugin: Plugin<DanmakuHostState, DanmakuActionMap>;
  readonly overlay: Overlay;
  inspect(): DanmakuInspection;
}

/** Stage px per font px at a picture height (comments grow with the player, within bounds). */
const scaleFor = (h: number): number => Math.min(1.5, Math.max(0.6, h / 540));

export function createDanmaku(options: DanmakuOptions = {}): DanmakuController {
  type S = DanmakuHostState;
  let store: Store<S, DanmakuActionMap> | undefined;
  let host: OverlayHost | undefined;
  let renderer: DanmakuRenderer | undefined;
  let stageEl: HTMLElement | undefined;
  let measure: CanvasRenderingContext2D | undefined;
  let offs: Unsubscribe[] = [];
  let hostOffs: Unsubscribe[] = [];
  const fs: FrameState<Comment> = { comments: [], position: 0, running: [], space: resetSpace() };
  let stage: Stage = { width: 0, height: 0, duration: SCROLL_S, fixedDuration: FIXED_S };
  let settings: DanmakuSettings = INITIAL_DANMAKU_STATE.danmaku;
  let blocked = blockTest([]);
  let px = 1;
  let dirty = true;
  let frames = 0;
  /** Media time drawn last, and the clock it was reported at (for interpolation). */
  let drawnTime = 0;
  let reported = Number.NaN;
  let reportedAt = 0;
  let loadSeq = 0;
  // Renderer choice (ADR-012 §5).
  const samples: FrameSample[] = [];
  let lastTick = Number.NaN;
  let switchedAt = 0;
  let switching = false;
  const unavailable = new Set<RendererKind>();
  // Mask (ADR-012 §6).
  let mask: MaskSource | undefined;
  let maskSeq = 0;
  let maskShown: MaskFrame | undefined;
  let maskMissing = 0;
  let drawnFrameTime = 0;
  let drawnLead = 0;

  const state = (): Readonly<S> => (store as Store<S, DanmakuActionMap>).getState();

  const hooks: FrameHooks<Comment> = {
    accept: (c) =>
      !(c.mode === 'top' ? settings.hideTop : c.mode === 'bottom' ? settings.hideBottom : settings.hideScroll) &&
      (c.own || (sampled(c.index, settings.density) && !blocked(c.text))),
    setup(c) {
      c.px = Math.round(c.size * settings.fontScale * px);
      if (measure !== undefined) {
        measure.font = font(c.px);
        c.width = Math.ceil(measure.measureText(c.text).width) + 4;
      }
      c.height = lineHeight(c.px);
      renderer?.prepare(c);
    },
    remove: (c) => renderer?.release(c),
  };

  /** Stage geometry from the picture rectangle and the settings; everything enters again. */
  const layout = (): void => {
    if (host === undefined || stageEl === undefined || renderer === undefined) return;
    const r = host.contentRect;
    Object.assign(stageEl.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.width}px`, height: `${r.height}px`, opacity: String(settings.opacity) });
    stageEl.hidden = !settings.enabled;
    px = scaleFor(r.height);
    stage = { width: r.width, height: r.height * settings.area, duration: SCROLL_S / settings.speed, fixedDuration: FIXED_S };
    renderer.resize(r.width, r.height, host.root.ownerDocument.defaultView?.devicePixelRatio ?? 1);
    rebuild(fs, drawnTime, stage, hooks);
    dirty = true;
  };

  const setComments = (inputs: readonly DanmakuInput[]): void => {
    fs.comments = inputs
      .map((c, index) => ({ c, index }))
      .sort((a, b) => a.c.time - b.c.time)
      .map(({ c, index }) => toComment(c, index));
    rebuild(fs, drawnTime, stage, hooks);
    dirty = true;
  };
  const toComment = (c: DanmakuInput, index: number): Comment => ({
    index,
    time: c.time,
    text: c.text.replace(/\s*\n\s*/g, ' '),
    mode: c.mode ?? 'rtl',
    color: c.color ?? 0xffffff,
    size: c.size ?? 25,
    own: c.own === true,
    px: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    sprite: undefined,
  });
  const status = (patch: Partial<DanmakuState['danmakuStatus']>): void => {
    store?.setState({ danmakuStatus: { ...state().danmakuStatus, ...patch } } as Partial<S>);
  };
  const step = (candidate: string, outcome: 'selected' | 'rejected' | 'failed', reason: string): void => {
    const steps = [...(store === undefined ? [] : state().danmakuStatus.steps), { candidate, outcome, reason }].slice(-20);
    status(outcome === 'selected' ? { steps, renderer: candidate, reason } : { steps });
  };

  /** Swaps the renderer: the running comments move over (their pictures are made again). */
  const use = (next: DanmakuRenderer, reason: string): void => {
    if (stageEl === undefined) return next.destroy();
    for (const c of fs.running) renderer?.release(c);
    renderer?.destroy();
    renderer = next;
    stageEl.replaceChildren(next.element);
    switchedAt = performance.now();
    samples.length = 0;
    step(next.kind, 'selected', reason);
    if (host !== undefined) next.resize(stage.width, host.contentRect.height, host.root.ownerDocument.defaultView?.devicePixelRatio ?? 1);
    for (const c of fs.running) next.prepare(c);
    dirty = true;
  };
  const switchTo = (kind: RendererKind, reason: string): void => {
    if (switching || host === undefined || renderer?.kind === kind) return;
    const doc = host.root.ownerDocument;
    // Not on this browser at all (a host's fixed choice too): rejected, the reason in the steps.
    const blocked = rendererBlocked(kind, doc.defaultView?.navigator.userAgent ?? '');
    if (blocked !== undefined) {
      unavailable.add(kind);
      step(kind, 'rejected', blocked);
      return;
    }
    if (kind === 'canvas2d') return use(createCanvasRenderer(doc), reason);
    switching = true;
    const fail = (why: string): void => {
      unavailable.add(kind);
      step(kind, 'rejected', why);
      switchedAt = performance.now();
    };
    const made =
      kind === 'webgl'
        ? import('./webgl.js').then((m) => m.createWebGlRenderer(doc, paintText))
        : import('./worker-renderer.js').then((m) =>
            m.createWorkerRenderer(doc, (why) => {
              fail(why);
              if (renderer?.kind === 'worker') use(createCanvasRenderer(doc), `Worker failed (${why}): Canvas 2D`);
            }),
          );
    void made.then(
      (r) => {
        switching = false;
        if (r === undefined) fail(kind === 'webgl' ? 'no WebGL2 context' : 'no OffscreenCanvas / Worker');
        else use(r, reason);
      },
      (err: unknown) => {
        switching = false;
        fail(String(err));
      },
    );
  };

  const plugin: DanmakuController['plugin'] = {
    id: 'danmaku',
    install(ctx: PluginContext<S, DanmakuActionMap>) {
      store = ctx.store;
      const s = ctx.store;
      offs = [
        s.handle('set-danmaku', (patch) => {
          settings = mergeSettings(state().danmaku, patch);
          blocked = blockTest(settings.blocked);
          s.setState({ danmaku: settings } as Partial<S>);
          layout();
        }),
        s.handle('load-danmaku', (req) => {
          const seq = ++loadSeq;
          if (req.comments !== undefined) {
            setComments(req.comments);
            status({ status: 'ready', count: fs.comments.length, skipped: 0 });
            return;
          }
          status({ status: 'loading' });
          void import('./parse.js')
            .then((m) => m.loadComments(req, options.fetch ?? ((u) => fetch(u))))
            .then(
              (r) => {
                if (seq !== loadSeq) return;
                setComments(r.comments);
                status({ status: 'ready', count: r.comments.length, skipped: r.skipped });
              },
              (err: unknown) => {
                if (seq === loadSeq) status({ status: 'error', reason: String(err) });
              },
            );
        }),
        s.handle('send-danmaku', ({ text, mode, color }) => {
          if (text.trim() === '') return;
          const c = toComment({ time: drawnTime, text, own: true, ...(mode === undefined ? {} : { mode }), ...(color === undefined ? {} : { color }) }, fs.comments.length);
          // At the next one to enter (upstream emit): shown on the next frame.
          const list = [...fs.comments];
          list.splice(fs.position, 0, c);
          fs.comments = list;
          status({ count: list.length });
          dirty = true;
        }),
        s.handle('load-danmaku-mask', (req) => {
          const seq = ++maskSeq;
          mask?.destroy();
          mask = undefined;
          const doc = host?.root.ownerDocument ?? (globalThis as { document?: Document }).document;
          if (doc === undefined) return;
          status({ mask: `${req.kind}: loading` });
          void import('./mask.js')
            .then(async (m) => {
              if (req.kind === 'webm') {
                const fps = req.fps ?? 30;
                // Ready once the first frame decoded with its alpha.
                const source = m.createWebmMask(
                  doc,
                  req.url as string,
                  fps,
                  (why) => seq === maskSeq && status({ mask: `webm rejected: ${why}` }),
                  () => seq === maskSeq && status({ mask: `webm: ${fps} fps` }),
                );
                return { source, what: undefined };
              }
              const frames = req.frames ?? ((await (await (options.fetch ?? ((u) => fetch(u)))(req.url as string)).json()) as { frames: { time: number; svg: string }[] }).frames;
              return { source: m.createSvgMask(doc, frames), what: `svg: ${frames.length} frames` };
            })
            .then(
              ({ source, what }) => {
                if (seq !== maskSeq) return source.destroy();
                mask = source;
                maskMissing = 0;
                dirty = true;
                if (what !== undefined) status({ mask: what });
              },
              (err: unknown) => seq === maskSeq && status({ mask: `${req.kind} rejected: ${String(err)}` }),
            );
        }),
        s.handle('clear-danmaku-mask', () => {
          maskSeq++;
          mask?.destroy();
          mask = undefined;
          dirty = true;
          status({ mask: null });
        }),
        s.handle('clear-danmaku', () => {
          loadSeq++;
          setComments([]);
          status({ status: 'idle', count: 0, skipped: 0 });
        }),
        // Another video: its comments are not this one's.
        s.select(
          (st) => st.source,
          () => {
            loadSeq++;
            maskSeq++;
            mask?.destroy();
            mask = undefined;
            setComments([]);
            status({ status: 'idle', count: 0, skipped: 0, mask: null });
          },
        ),
      ];
      settings = state().danmaku;
      blocked = blockTest(settings.blocked);
    },
    uninstall() {
      for (const off of offs) off();
      offs = [];
      store = undefined;
    },
  };

  const overlay: Overlay = {
    id: 'danmaku',
    // Above captions (200) would hide them: below, as B站 (captions stay readable).
    zIndex: 100,
    mount(h) {
      host = h;
      const doc = h.root.ownerDocument;
      renderer = createCanvasRenderer(doc);
      stageEl = doc.createElement('div');
      stageEl.dataset['otterDanmaku'] = '';
      stageEl.style.position = 'absolute';
      stageEl.append(renderer.element);
      h.root.append(stageEl);
      measure = doc.createElement('canvas').getContext('2d') ?? undefined;
      const wanted = options.renderer ?? 'auto';
      step('canvas2d', 'selected', wanted === 'auto' ? 'default: Canvas 2D (auto)' : wanted === 'canvas2d' ? 'host: Canvas 2D' : `start; host asks for ${wanted}`);
      if (wanted !== 'auto' && wanted !== 'canvas2d') switchTo(wanted, `host: ${wanted}`);
      hostOffs = [h.onContentRectChange(layout)];
      layout();
    },
    tick(now, mediaTime, frameTime) {
      if (store === undefined || renderer === undefined || !settings.enabled) return;
      const doc = host?.root.ownerDocument;
      // A hidden page draws nothing (SPEC §15 后台).
      if (doc?.visibilityState === 'hidden') return;
      const interval = Number.isNaN(lastTick) ? 16.7 : now - lastTick;
      lastTick = now;
      const s = state();
      const running = s.paused === false && s.seeking !== true && s.waiting !== true && s.ended !== true;
      const rate = s.playbackRate ?? 1;
      // Media time between the element's reports (some engines update it per video frame): on
      // from the last report at the playback rate, at most 0.25 s ahead.
      if (mediaTime !== reported) {
        const jumped = mediaTime < drawnTime - 0.3 || mediaTime > drawnTime + 1.5 + (Number.isNaN(reported) ? 0 : ((now - reportedAt) / 1000) * rate);
        reported = mediaTime;
        reportedAt = now;
        if (jumped) {
          // A seek: the stage as it is at the new time.
          drawnTime = mediaTime;
          rebuild(fs, mediaTime, stage, hooks);
          dirty = true;
        }
      }
      // The stage reaches the screen a display frame after the video's own frame (the video is
      // composited apart from the page); a renderer that shows its frame later still (the Worker)
      // adds its latency. Drawn that far ahead while playing, so masks keep to their frame.
      const lead = running ? ((DISPLAY_FRAME_MS + (renderer.latencyMs ?? 0)) / 1000) * rate : 0;
      const t = running ? Math.max(drawnTime, mediaTime + Math.min(0.25, ((now - reportedAt) / 1000) * rate) + lead) : mediaTime;
      // The mask of the picture on screen (its own frame time when the shell tracks it).
      const ft = (frameTime ?? mediaTime) + lead;
      const m = mask?.at(ft);
      if (m?.version !== maskShown?.version) dirty = true;
      if (t === drawnTime && !dirty) return;
      maskShown = m;
      drawnFrameTime = ft;
      drawnLead = lead;
      if (mask !== undefined && m === undefined) maskMissing++;
      drawnTime = t;
      dirty = false;
      const t0 = performance.now();
      frame(fs, t, stage, hooks);
      renderer.draw(fs.running, m);
      frames++;
      samples.push({ onStage: fs.running.length, drawMs: performance.now() - t0, intervalMs: interval });
      if (samples.length > 600) samples.splice(0, samples.length - 600);
      if ((options.renderer ?? 'auto') !== 'auto') return;
      const ua = doc?.defaultView?.navigator.userAgent ?? '';
      const available = new Set<RendererKind>((['canvas2d', 'webgl', 'worker'] as const).filter((k) => !unavailable.has(k) && rendererBlocked(k, ua) === undefined));
      const d = decide(renderer.kind as RendererKind, samples, performance.now() - switchedAt, available);
      if (d === undefined) return;
      if (d.reject !== undefined) {
        unavailable.add(d.reject);
        step(d.reject, 'rejected', `slower here: ${d.reason}`);
      }
      switchTo(d.to, d.reason);
    },
    destroy() {
      for (const off of hostOffs) off();
      hostOffs = [];
      for (const c of fs.running) renderer?.release(c);
      fs.running = [];
      renderer?.destroy();
      renderer = undefined;
      stageEl?.remove();
      stageEl = undefined;
      host = undefined;
    },
  };

  return {
    plugin,
    overlay,
    inspect: () => ({
      time: drawnTime,
      frameTime: drawnFrameTime,
      lead: drawnLead,
      maskIndex: maskShown?.index ?? null,
      maskMissing,
      frames,
      renderer: renderer?.kind ?? null,
      ownFrameP95: (() => {
        const xs = renderer?.ownIntervals;
        if (xs === undefined || xs.length === 0) return null;
        return [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? null;
      })(),
      cost: (() => {
        const xs = samples.map((f) => f.drawMs).sort((a, b) => a - b);
        return { p50: xs[Math.floor(xs.length * 0.5)] ?? 0, p95: xs[Math.floor(xs.length * 0.95)] ?? 0 };
      })(),
      stage: { width: stage.width, height: stage.height, duration: stage.duration },
      running: fs.running.map((c) => ({ text: c.text, mode: c.mode, time: c.time, x: c.x, y: c.y, width: c.width })),
    }),
  };
}

/** The overlay alone (comments come from a `createDanmaku()` plugin sharing the same controller). */
export function createDanmakuOverlay(options: DanmakuOptions = {}): Overlay {
  return createDanmaku(options).overlay;
}
