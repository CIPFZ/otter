// State and actions of the picture controls (SPEC §12 电子放大, ADR-008 §6): what the shell shows
// and the settings menu edits. Apart from the plugin so the menu's on-demand chunk can read it
// without loading the plugin.

import type { StoreSlice } from '@otter-player/core';
import type { SurfaceFilters } from '@otter-player/surface';

/** Electronic zoom limits: 1 = the picture as fitted, 8 = eight times that. */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;

export interface PictureState {
  /** Electronic zoom, 1..8 (1: the fitted picture). */
  readonly zoom: number;
  /** Offset of the zoomed picture from its centre, fractions of the player box (-1..1). */
  readonly pan: readonly [number, number];
  readonly rotate: 0 | 90 | 180 | 270;
  readonly mirror: boolean;
  readonly filters: SurfaceFilters;
}

export const NEUTRAL_PICTURE: PictureState = {
  zoom: 1,
  pan: [0, 0],
  rotate: 0,
  mirror: false,
  filters: { brightness: 1, contrast: 1, saturate: 1, temperature: 0, sharpen: 0 },
};

/** Store shape: the picture state under one key, `picture`. */
export interface PictureSliceState {
  readonly picture: PictureState;
}

export const PICTURE_SLICE: StoreSlice<PictureSliceState> = { id: 'picture', initialState: { picture: NEUTRAL_PICTURE } };

export interface PictureActionMap {
  /** Signed zoom by `factor` (2 = one notch up), keeping the point at (x, y) where it is. */
  'zoom-at': { readonly factor: number; readonly x: number; readonly y: number };
  /** Drag of the zoomed picture, fractions of the player box. */
  'pan-by': { readonly dx: number; readonly dy: number };
  'set-filters': { readonly filters: Partial<SurfaceFilters> };
  'set-rotate': { readonly rotate: 0 | 90 | 180 | 270 };
  'set-mirror': { readonly mirror: boolean };
  'reset-picture': Record<string, never>;
}

