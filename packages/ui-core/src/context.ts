// Store context for UI primitives (SPEC §3 rule 1): the host provides a StoreView on the player
// root; elements find it by walking up the tree (crossing shadow roots). Elements read state and
// dispatch actions only.

import type { StoreView } from '@otter-player/core';
import type { MediaActionMap, MediaState, ThumbnailProvider } from '@otter-player/media';
import type { PresentationActionMap, PresentationState } from '@otter-player/presentation';
import type { PictureActionMap, PictureState } from '@otter-player/presentation/picture';
import type { QoeState } from '@otter-player/qoe';
import type { TextActionMap, TextState } from '@otter-player/text';
import type { PlayerUiActionMap, PlayerUiState } from './player-ui.js';

/**
 * State the primitives read: the media session plus whatever the shell added. `qoe` is optional
 * (the stats panel shows what is available); text / player UI / presentation slices may be absent.
 */
export type UiState = MediaState &
  Partial<QoeState> &
  Partial<TextState> &
  Partial<PlayerUiState> &
  Partial<PresentationState> &
  /** The picture plugin's state, when the host installs it (picture controls). */
  Partial<{ readonly picture: PictureState }> &
  /** Danmaku settings, when the host installs `@otter-player/danmaku` (structural: no dependency). */
  Partial<{ readonly danmaku: DanmakuView }>;
/** The part of `@otter-player/danmaku`'s DanmakuSettings the settings page shows. */
export interface DanmakuView {
  readonly enabled: boolean;
  readonly opacity: number;
  readonly fontScale: number;
  readonly speed: number;
  readonly area: number;
  readonly density: number;
  readonly hideScroll: boolean;
  readonly hideTop: boolean;
  readonly hideBottom: boolean;
}
/**
 * The actions the UI dispatches: media, player UI and, when present, presentation, text, picture and
 * danmaku.
 */
export type UiActions = MediaActionMap &
  PlayerUiActionMap &
  TextActionMap &
  PresentationActionMap &
  Partial<PictureActionMap> &
  Partial<{ 'set-danmaku': Partial<DanmakuView> }>;
/** The store the `otter-*` elements read: provided on the player root. */
export type UiStore = StoreView<UiState, UiActions>;

const stores = new WeakMap<Node, UiStore>();

/** Elements that want to be told when a store becomes available on an ancestor. */
export interface StoreConsumer {
  /** Called when a store is provided on an ancestor after the element connected. */
  connectStore(): void;
}

const isConsumer = (n: unknown): n is StoreConsumer =>
  typeof n === 'object' && n !== null && typeof (n as Partial<StoreConsumer>).connectStore === 'function';

/**
 * Makes a store the one the `otter-*` elements inside `root` read (createPlayer does it); elements
 * already connected pick it up now.
 */
export function provideStore(root: HTMLElement, store: StoreView<UiState, UiActions>): void {
  stores.set(root, store);
  // Elements connected before the store was provided pick it up now.
  for (const el of Array.from(root.querySelectorAll('*'))) if (isConsumer(el)) el.connectStore();
}

/** Nearest value registered on `from` or an ancestor (crossing shadow roots). */
function lookup<T>(map: WeakMap<Node, T>, from: Node): T | undefined {
  let node: Node | null = from;
  while (node !== null) {
    const value = map.get(node);
    if (value !== undefined) return value;
    const parent: Node | null = node.parentNode;
    // Step out of a shadow root to its host.
    node = parent ?? ((node as { host?: Node }).host ?? null);
  }
  return undefined;
}

/** The store provided on `from` or its nearest ancestor (across shadow roots). */
export function findStore(from: Node): UiStore | undefined {
  return lookup(stores, from);
}

const thumbnails = new WeakMap<Node, ThumbnailProvider>();

/** Seek-preview pictures for the progress bar's card (ADR-007 §7); null removes them. */
export function provideThumbnails(root: HTMLElement, provider: ThumbnailProvider | null): void {
  if (provider === null) thumbnails.delete(root);
  else thumbnails.set(root, provider);
}

/** The preview-picture provider on `from` or its nearest ancestor. */
export function findThumbnails(from: Node): ThumbnailProvider | undefined {
  return lookup(thumbnails, from);
}
