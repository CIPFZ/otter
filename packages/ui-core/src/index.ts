// UI primitives and features (SPEC §14, §17). Primitives are Web Components with the `otter-`
// prefix; each binds one piece of state to one piece of DOM, styled through --otter-* custom
// properties, ::part() and slots. Elements are defined explicitly by the host, never on import.

import type { StoreSlice } from '@otter-player/core';
import type { GestureMap, HotkeyMap } from '@otter-player/input';
import type { Overlay } from '@otter-player/surface';

export interface UIFeature {
  readonly id: string;
  readonly slices?: StoreSlice[];
  readonly components?: CustomElementConstructor[];
  readonly hotkeys?: HotkeyMap;
  readonly gestures?: GestureMap;
  readonly overlays?: Overlay[];
}

/** Identity helper that keeps the literal type of a feature definition. */
export function defineUIFeature<const F extends UIFeature>(feature: F): F {
  return feature;
}

/** Tag names of the SPEC §14.1 primitives. */
export const OTTER_ELEMENTS = {
  PlayButton: 'otter-play-button',
  MuteButton: 'otter-mute-button',
  VolumeSlider: 'otter-volume-slider',
  TimeSlider: 'otter-time-slider',
  TimeDisplay: 'otter-time-display',
  LiveIndicator: 'otter-live-indicator',
  Menu: 'otter-menu',
  MenuItem: 'otter-menu-item',
  Tooltip: 'otter-tooltip',
  Gesture: 'otter-gesture',
  Poster: 'otter-poster',
  Spinner: 'otter-spinner',
  Announcer: 'otter-announcer',
} as const;

export type OtterElementName = (typeof OTTER_ELEMENTS)[keyof typeof OTTER_ELEMENTS];

export { findStore, provideStore, type StoreConsumer, type UiActions, type UiState, type UiStore } from './context.js';
export {
  defineElements,
  defineOtterElements,
  otterAnnouncer,
  otterBigPlay,
  otterErrorCard,
  otterFeedback,
  otterQualityMenu,
  otterSeekButton,
  otterSpeedMenu,
  otterCaptionsButton,
  otterFullscreenButton,
  otterGesture,
  otterLiveIndicator,
  otterMenu,
  otterMenuItem,
  otterMuteButton,
  otterPipButton,
  otterPlayButton,
  otterPoster,
  otterSettingsMenu,
  otterSpinner,
  otterStats,
  otterTimeDisplay,
  otterTimeSlider,
  otterTooltip,
  otterVolumeSlider,
  M1_ELEMENTS,
  M2_ELEMENTS,
  M25_ELEMENTS,
  captionStyleGroups,
  settingsGroups,
  type DefineOptions,
  type MenuGroup,
  type MenuOption,
} from './elements.js';
export { formatBitrate, formatMs, formatSeconds, formatTime, speakTime } from './format.js';
export {
  bindActivity,
  CHROME_SLICE,
  createChromePlugin,
  INITIAL_CHROME_STATE,
  type ChromeActionMap,
  type ChromeOptions,
  type ChromeState,
  type ChromeUiActions,
} from './chrome.js';
export { icon, type IconNode } from './icons.js';
export { fill, findStrings, provideStrings, STRINGS_EN, STRINGS_ZH, type UiStrings } from './strings.js';
