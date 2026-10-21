// Picture (SPEC §12 电子放大, ADR-008 §6): zoom, pan, rotation, mirroring and filters of the
// playing picture, as store state a plugin applies to the Surface. Wheel, pinch and drag come from
// the input controller (`zoom-at`, `pan-by`); the settings menu sets the filters. Hosts that do not
// install it keep the gestures inert (no handler registered for those actions).

import type { Plugin, PluginContext, Store, Unsubscribe } from '@otter-player/core';
import type { Surface, SurfaceTransform } from '@otter-player/surface';
import { computeContentRect, IDENTITY_TRANSFORM } from '@otter-player/surface';
import { NEUTRAL_PICTURE, ZOOM_MAX, ZOOM_MIN, type PictureActionMap, type PictureSliceState, type PictureState } from './picture-state.js';

export interface PictureOptions {
  /** The surface in use (the shell may switch players, e.g. the focused tile of a wall). */
  readonly surface: () => Surface;
  /** The picture area excludes the controls' band; the shell reports its height in px. */
  readonly controlsInset?: () => number;
}

export type { PictureActionMap, PictureSliceState, PictureState } from './picture-state.js';
export { NEUTRAL_PICTURE, PICTURE_SLICE, ZOOM_MAX, ZOOM_MIN } from './picture-state.js';

export interface PicturePlugin<S extends PictureSliceState> extends Plugin<S, PictureActionMap> {
  transform(): SurfaceTransform;
  /** Re-read the surface's box and picture and apply the state to it (after a surface switch). */
  refresh(): void;
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export function createPicturePlugin<S extends PictureSliceState>(options: PictureOptions): PicturePlugin<S> {
  const surface = options.surface;
  let store: Store<S, PictureActionMap> | undefined;
  let offs: Unsubscribe[] = [];
  // The same numbers the surface computes with: box, picture size, and the fitted (unzoomed) rect.
  let box = { width: 0, height: 0 };
  let picture = { width: 0, height: 0 };
  let fitted = { x: 0, y: 0, width: 0, height: 0 };

  const inset = (): number => Math.max(0, options.controlsInset?.() ?? 0);
  /** Picture area for zoom and pan: the box above the controls. */
  const viewport = (): { width: number; height: number } => ({ width: box.width, height: Math.max(0, box.height - inset()) });

  /** Fitted (unzoomed) picture rectangle, with the surface's own maths. */
  const measure = (): void => {
    const el = surface().element;
    box = { width: el.clientWidth, height: el.clientHeight };
    picture = el instanceof HTMLVideoElement ? { width: el.videoWidth, height: el.videoHeight } : { width: el.width, height: el.height };
    const t: SurfaceTransform = { ...IDENTITY_TRANSFORM, ...(inset() > 0 ? { viewportBottom: inset() } : {}) };
    fitted = computeContentRect(box, picture, 'contain', t);
  };

  /** The surface transform for `s`: pan in pixels of the viewport (state keeps fractions). */
  const toTransform = (s: Readonly<PictureState>): SurfaceTransform => {
    measure();
    const view = viewport();
    return {
      rotate: s.rotate,
      mirror: s.mirror,
      zoom: s.zoom,
      pan: [s.pan[0] * view.width, s.pan[1] * view.height],
      ...(inset() > 0 ? { viewportBottom: inset() } : {}),
    };
  };
  const apply = (s: Readonly<PictureState>): void => {
    surface().setTransform(toTransform(s));
    surface().setFilters(s.filters);
  };

  return {
    id: 'picture',
    refresh() {
      measure();
      const s = store?.getState().picture;
      if (s !== undefined) apply(s);
    },
    transform() {
      const s = store?.getState().picture;
      return s === undefined ? IDENTITY_TRANSFORM : toTransform(s);
    },
    install(ctx: PluginContext<S, PictureActionMap>) {
      store = ctx.store;
      measure();
      const get = (): PictureState | undefined => store?.getState().picture;
      const patch = (p: Partial<PictureState>): void => {
        const cur = get();
        if (cur !== undefined) store?.setState({ picture: { ...cur, ...p } } as Partial<S>);
      };
      /** Pan limits for a zoom, in fractions of the viewport (0 when the picture fits). */
      const limits = (zoom: number): [number, number] => {
        // Measured now: the picture may have got its size (metadata) or the box changed since.
        measure();
        const view = viewport();
        const roomX = Math.max(0, fitted.width * zoom - view.width) / 2 / Math.max(1, view.width);
        const roomY = Math.max(0, fitted.height * zoom - view.height) / 2 / Math.max(1, view.height);
        return [roomX, roomY];
      };
      const withPan = (zoom: number, pan: readonly [number, number]): readonly [number, number] => {
        const [mx, my] = limits(zoom);
        return [clamp(pan[0], -mx, mx), clamp(pan[1], -my, my)];
      };
      offs = [
        ctx.store.handle('zoom-at', ({ factor, x, y }) => {
          const s = get();
          if (s === undefined) return;
          const zoom = clamp(s.zoom * factor, ZOOM_MIN, ZOOM_MAX);
          if (zoom === s.zoom) return;
          // Keep the picture point under (x, y) where it is, in pixels: the picture centre is the
          // fit's centre unzoomed and the viewport's centre plus pan zoomed (the viewport leaves
          // the controls' band out).
          measure();
          const view = viewport();
          const vc = [view.width / 2, view.height / 2];
          const centre = (z: number, pan: readonly [number, number]): [number, number] =>
            z === 1 ? [fitted.x + fitted.width / 2, fitted.y + fitted.height / 2] : [(vc[0] as number) + pan[0] * view.width, (vc[1] as number) + pan[1] * view.height];
          const [cx, cy] = centre(s.zoom, s.pan);
          const px = x * box.width;
          const py = y * box.height;
          const nx = px - ((px - cx) * zoom) / s.zoom;
          const ny = py - ((py - cy) * zoom) / s.zoom;
          const pan: [number, number] = [(nx - (vc[0] as number)) / Math.max(1, view.width), (ny - (vc[1] as number)) / Math.max(1, view.height)];
          // Back at the fitted picture there is nothing to pan (and no -0 left behind).
          patch({ zoom, pan: zoom === ZOOM_MIN ? [0, 0] : withPan(zoom, pan) });
        }),
        ctx.store.handle('pan-by', ({ dx, dy }) => {
          const s = get();
          if (s === undefined || s.zoom <= 1) return;
          patch({ pan: withPan(s.zoom, [s.pan[0] + dx, s.pan[1] + dy]) });
        }),
        ctx.store.handle('set-filters', ({ filters }) => {
          const s = get();
          if (s === undefined) return;
          patch({ filters: { ...s.filters, ...filters } });
        }),
        ctx.store.handle('set-rotate', ({ rotate }) => patch({ rotate, pan: [0, 0] })),
        ctx.store.handle('set-mirror', ({ mirror }) => patch({ mirror })),
        ctx.store.handle('reset-picture', () => patch({ ...NEUTRAL_PICTURE, filters: { ...NEUTRAL_PICTURE.filters } })),
        // Re-apply on every change (and after a resize, when the limits move).
        ctx.store.select(
          (st) => st.picture,
          (p) => apply(p),
        ),
      ];
      apply(ctx.store.getState().picture);
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => measure()) : undefined;
      observer?.observe(surface().element);
      offs.push(() => observer?.disconnect());
    },
    uninstall() {
      for (const off of offs) off();
      offs = [];
      surface().setTransform(IDENTITY_TRANSFORM);
      surface().setFilters(NEUTRAL_PICTURE.filters);
      store = undefined;
    },
  };
}
