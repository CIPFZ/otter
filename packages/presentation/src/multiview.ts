// Multi-view wall (SPEC §15 多宫格, ADR-008 §7): many player instances on one canvas, one WebGL2
// context with a viewport per stream (CanvasSurface per tile where WebGL2 is missing). Click or
// Enter focuses a tile (the host lets only the focused stream play sound and points its controls
// at it, see createStoreSwitch); double-click or Shift+Enter expands a tile to the whole wall
// (local fullscreen) and back. Tiles are buttons over their regions: keyboard and screen readers
// reach every stream.

import { createError, type StateListener, type StoreView, type Unsubscribe } from '@otter-player/core';
import { createCanvasSurface, createGPUGrid, type FrameSurface, type GPUGrid, type GPUView, type Region } from '@otter-player/surface/gpu';

export interface MultiviewOptions {
  /** Box the wall fills (position: relative or absolute is set if static). */
  readonly container: HTMLElement;
  /** Columns; default: the smallest square that fits all tiles. */
  readonly columns?: number;
  /** Accessible name of the wall. */
  readonly label?: string;
  /**
   * Inserted before this child of the container (e.g. the player's bars: the wall above the
   * gesture / poster layers, under every control). Default: first child.
   */
  readonly before?: Element | null;
}

export interface MultiviewTile {
  readonly id: number;
  readonly label: string;
  /** Where this stream's pictures go (WebCodecs backend `sink`). */
  readonly surface: FrameSurface;
  /** The tile's button over its region (focus ring, label). */
  readonly element: HTMLElement;
  remove(): void;
}

export interface Multiview {
  readonly element: HTMLElement;
  /** 'gpu': one shared WebGL2 context; 'canvas2d': a 2D canvas per tile (no WebGL2). */
  readonly kind: 'gpu' | 'canvas2d';
  readonly tiles: readonly MultiviewTile[];
  readonly focused: MultiviewTile | undefined;
  readonly expanded: MultiviewTile | undefined;
  add(label?: string): MultiviewTile;
  focus(tile: MultiviewTile): void;
  /** Local fullscreen of one tile; undefined goes back to the grid. */
  expand(tile: MultiviewTile | undefined): void;
  on(event: 'focus' | 'expand', h: (tile: MultiviewTile | undefined) => void): Unsubscribe;
  destroy(): void;
}

const HIDDEN: Region = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Tiles a wall without WebGL2 takes: each one is a 2D canvas drawn on the main thread, which
 * keeps up with about 4 streams (16 x 720p fell to ~10 fps). ADR-008 §7.
 */
export const CANVAS2D_MAX_TILES = 4;

export function createMultiview(options: MultiviewOptions): Multiview {
  const { container } = options;
  const doc = container.ownerDocument;
  if (doc.defaultView?.getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const wall = doc.createElement('div');
  wall.setAttribute('data-otter-multiview', '');
  wall.setAttribute('role', 'group');
  wall.setAttribute('aria-label', options.label ?? 'Multi-view');
  wall.style.cssText = 'position:absolute;inset:0;background:#000';
  const canvas = doc.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  wall.append(canvas);
  // Stacking by DOM order: under everything after it (the controls), over everything before it.
  if (options.before?.parentNode === container) container.insertBefore(wall, options.before);
  else container.prepend(wall);

  let grid: GPUGrid | undefined;
  try {
    // Many views: uploads and draws in a render Worker where it can hold WebGL2.
    grid = createGPUGrid(canvas, { worker: true });
  } catch (err) {
    if ((err as { details?: string } | null)?.details !== 'webgl2Unavailable') throw err;
    canvas.remove();
  }
  const kind: Multiview['kind'] = grid === undefined ? 'canvas2d' : 'gpu';

  type Tile = MultiviewTile & { view: GPUView | undefined; canvas: HTMLCanvasElement | undefined };
  const tiles: Tile[] = [];
  const handlers = { focus: new Set<(t: MultiviewTile | undefined) => void>(), expand: new Set<(t: MultiviewTile | undefined) => void>() };
  let focused: Tile | undefined;
  let expanded: Tile | undefined;
  let ids = 0;

  const regionOf = (index: number, count: number): Region => {
    const cols = options.columns ?? Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / cols));
    const col = index % cols;
    const row = Math.floor(index / cols);
    return { x: col / cols, y: row / rows, width: 1 / cols, height: 1 / rows };
  };
  const layout = (): void => {
    tiles.forEach((t, i) => {
      const r = expanded === undefined ? regionOf(i, tiles.length) : t === expanded ? { x: 0, y: 0, width: 1, height: 1 } : HIDDEN;
      t.view?.setRegion(r);
      const box = (el: HTMLElement): void => {
        el.style.left = `${r.x * 100}%`;
        el.style.top = `${r.y * 100}%`;
        el.style.width = `${r.width * 100}%`;
        el.style.height = `${r.height * 100}%`;
        el.hidden = r.width === 0;
      };
      box(t.element);
      if (t.canvas !== undefined) box(t.canvas);
    });
  };
  const emit = (e: 'focus' | 'expand', t: MultiviewTile | undefined): void => {
    for (const h of handlers[e]) h(t);
  };

  const wallApi: Multiview = {
    element: wall,
    kind,
    get tiles() {
      return [...tiles];
    },
    get focused() {
      return focused;
    },
    get expanded() {
      return expanded;
    },
    add(label) {
      if (grid === undefined && tiles.length >= CANVAS2D_MAX_TILES) {
        throw createError({
          type: 'other',
          details: 'gpuUnavailable',
          fatal: false,
          recoverable: false,
          message: `no WebGL2 here: a multi-view wall takes at most ${CANVAS2D_MAX_TILES} streams on 2D canvases`,
        });
      }
      const id = ++ids;
      const name = label ?? `Stream ${id}`;
      const button = doc.createElement('div');
      button.setAttribute('data-otter-multiview-tile', String(id));
      button.setAttribute('role', 'button');
      button.setAttribute('tabindex', '0');
      button.setAttribute('aria-label', name);
      button.setAttribute('aria-pressed', 'false');
      button.style.cssText = 'position:absolute;box-sizing:border-box;outline:none;cursor:pointer';
      let tileCanvas: HTMLCanvasElement | undefined;
      let surface: FrameSurface;
      let view: GPUView | undefined;
      if (grid !== undefined) {
        view = grid.createView(regionOf(tiles.length, tiles.length + 1));
        surface = view;
      } else {
        tileCanvas = doc.createElement('canvas');
        tileCanvas.style.cssText = 'position:absolute;display:block';
        wall.insertBefore(tileCanvas, wall.firstChild);
        surface = createCanvasSurface(tileCanvas);
      }
      wall.append(button);
      const tile: Tile = {
        id,
        label: name,
        surface,
        element: button,
        view,
        canvas: tileCanvas,
        remove() {
          const i = tiles.indexOf(tile);
          if (i < 0) return;
          tiles.splice(i, 1);
          surface.destroy();
          tileCanvas?.remove();
          button.remove();
          if (expanded === tile) expanded = undefined;
          if (focused === tile) {
            focused = undefined;
            emit('focus', undefined);
          }
          layout();
        },
      };
      button.addEventListener('click', () => wallApi.focus(tile));
      button.addEventListener('dblclick', () => wallApi.expand(expanded === tile ? undefined : tile));
      button.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        if (e.shiftKey) wallApi.expand(expanded === tile ? undefined : tile);
        else wallApi.focus(tile);
      });
      tiles.push(tile);
      layout();
      if (focused === undefined) wallApi.focus(tile);
      return tile;
    },
    focus(tile) {
      const t = tile as Tile;
      if (focused === t || !tiles.includes(t)) return;
      focused?.element.setAttribute('aria-pressed', 'false');
      if (focused !== undefined) focused.element.style.boxShadow = '';
      focused = t;
      t.element.setAttribute('aria-pressed', 'true');
      t.element.style.boxShadow = 'inset 0 0 0 2px var(--otter-accent, #4c9aff)';
      emit('focus', t);
    },
    expand(tile) {
      const t = tile as Tile | undefined;
      if (expanded === t || (t !== undefined && !tiles.includes(t))) return;
      expanded = t;
      if (t !== undefined) wallApi.focus(t);
      layout();
      emit('expand', t);
    },
    on(event, h) {
      handlers[event].add(h);
      return () => handlers[event].delete(h);
    },
    destroy() {
      for (const t of [...tiles]) t.remove();
      grid?.destroy();
      wall.remove();
      handlers.focus.clear();
      handlers.expand.clear();
    },
  };
  return wallApi;
}

/**
 * The store the shell's controls bind to on a wall: the shell's own state (chrome, presentation,
 * ...) with the focused tile's state over it, actions to the focused tile first (media actions)
 * and to the shell otherwise. `focus(next)` moves it to another tile; subscribers are told.
 */
export function createFocusStore<S extends object, A extends object>(shell: StoreView<S, A>, initial: StoreView<S, A>): { readonly view: StoreView<S, A>; focus(next: StoreView<S, A>): void; destroy(): void } {
  let target = initial;
  let merged: Readonly<S> | undefined;
  const listeners = new Set<StateListener<S>>();
  const state = (): Readonly<S> => (merged ??= { ...shell.getState(), ...target.getState() });
  const notify = (): void => {
    const prev = state();
    merged = undefined;
    const next = state();
    for (const l of listeners) l(next, prev);
  };
  const offShell = shell.subscribe(notify);
  let offTarget = target.subscribe(notify);
  const view: StoreView<S, A> = {
    getState: state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(selector, listener, equals = Object.is) {
      let prev = selector(state());
      return view.subscribe((s) => {
        const next = selector(s);
        if (equals(next, prev)) return;
        const old = prev;
        prev = next;
        listener(next, old);
      });
    },
    dispatch: (type, payload, trigger) => target.dispatch(type, payload, trigger) || shell.dispatch(type, payload, trigger),
  };
  return {
    view,
    focus(next) {
      if (next === target) return;
      offTarget();
      target = next;
      offTarget = target.subscribe(notify);
      notify();
    },
    destroy() {
      offShell();
      offTarget();
      listeners.clear();
    },
  };
}
