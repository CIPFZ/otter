// Overlay layer (SPEC §13): the OverlayHost implementation a player shell mounts above the
// Surface. One rAF loop drives every overlay's tick (SPEC §3 rule 4); overlays get the picture
// rectangle and the chrome's safe area, never the <video> element.

import type { StoreView, Unsubscribe } from '@otter-player/core';
import type { Insets, Overlay, OverlayHost } from './overlay.js';
import type { Surface } from './surface.js';

export interface OverlayLayerOptions<S extends object, A extends object> {
  /** Element the layer is appended to; it covers the surface element's box. */
  readonly container: HTMLElement;
  readonly surface: Surface;
  readonly store: StoreView<S, A>;
  /** Media clock for ticks, seconds (the shell reads it from the backend element). */
  readonly mediaTime: () => number;
}

export interface OverlayLayer {
  readonly element: HTMLElement;
  add(overlay: Overlay): Unsubscribe;
  /** Space the chrome covers (control bar height when shown); overlays move out of it. */
  setSafeArea(insets: Insets): void;
  readonly safeArea: Insets;
  destroy(): void;
}

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

export function createOverlayLayer<S extends object, A extends object>(options: OverlayLayerOptions<S, A>): OverlayLayer {
  const { container, surface, store, mediaTime } = options;
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const element = doc.createElement('div');
  element.dataset['otterOverlays'] = '';
  Object.assign(element.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
  // Right above the picture, below the chrome that follows it in the container.
  const anchor = surface.element.parentNode === container ? surface.element.nextSibling : null;
  container.insertBefore(element, anchor);

  const mounted = new Map<Overlay, HTMLElement>();
  let safeArea = NO_INSETS;
  let frame: number | undefined;

  const loop = (now: number): void => {
    frame = win?.requestAnimationFrame(loop);
    const t = mediaTime();
    for (const overlay of mounted.keys()) overlay.tick?.(now, t);
  };
  const start = (): void => {
    if (frame === undefined && win !== null && mounted.size > 0) frame = win.requestAnimationFrame(loop);
  };
  const stop = (): void => {
    if (frame !== undefined) win?.cancelAnimationFrame(frame);
    frame = undefined;
  };

  return {
    element,
    get safeArea() {
      return safeArea;
    },
    add(overlay) {
      const root = doc.createElement('div');
      root.dataset['overlay'] = overlay.id;
      Object.assign(root.style, { position: 'absolute', inset: '0', zIndex: String(overlay.zIndex) });
      element.appendChild(root);
      const host: OverlayHost = {
        root,
        get contentRect() {
          return surface.contentRect;
        },
        get safeArea() {
          return safeArea;
        },
        store: store as unknown as OverlayHost['store'],
        onContentRectChange: (h) => surface.onContentRectChange(h),
      };
      mounted.set(overlay, root);
      overlay.mount(host);
      overlay.setSafeArea?.(safeArea);
      start();
      return () => {
        if (!mounted.delete(overlay)) return;
        overlay.destroy();
        root.remove();
        if (mounted.size === 0) stop();
      };
    },
    setSafeArea(insets) {
      safeArea = insets;
      for (const overlay of mounted.keys()) overlay.setSafeArea?.(insets);
    },
    destroy() {
      stop();
      for (const [overlay, root] of mounted) {
        overlay.destroy();
        root.remove();
      }
      mounted.clear();
      element.remove();
    },
  };
}
