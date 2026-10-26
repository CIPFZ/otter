// Overlay (SPEC §13): layers above the picture and below the chrome (captions, danmaku,
// watermark, ads, hotspots, poster, loading, error). Defined here, next to Surface, because the
// host hands every overlay the Surface's picture rectangle rather than the container rectangle.

import type { StoreView, Unsubscribe } from '@otter-player/core';

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * Provided by the player shell to each overlay. The host also drives `Overlay.tick` from the
 * single presentation rAF shared by captions, danmaku and UI animation (SPEC §3 rule 4).
 */
export interface OverlayHost<S extends object = object, A extends object = object> {
  /** Layer element the overlay renders into. */
  readonly root: HTMLElement;
  /** Picture rectangle (letterbox excluded), so captions stay on the picture. */
  readonly contentRect: DOMRectReadOnly;
  /** Space taken by the chrome layer (e.g. control bar), captions move up accordingly. */
  readonly safeArea: Insets;
  /** Read state, dispatch actions; never the engine or the <video> element. */
  readonly store: StoreView<S, A>;
  onContentRectChange(h: (r: DOMRectReadOnly) => void): Unsubscribe;
}

export interface Overlay {
  readonly id: string;
  readonly zIndex: number;
  mount(host: OverlayHost): void;
  /**
   * Called from the shared rAF. `now` is the rAF timestamp, `mediaTime` in seconds; `frameTime`:
   * media time of the picture on screen (requestVideoFrameCallback), when the shell tracks it.
   */
  tick?(now: number, mediaTime: number, frameTime?: number): void;
  setSafeArea?(insets: Insets): void;
  destroy(): void;
}
