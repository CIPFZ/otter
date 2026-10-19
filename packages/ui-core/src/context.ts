// Store context for UI primitives (SPEC §3 rule 1): the host provides a StoreView on the player
// root; elements find it by walking up the tree (crossing shadow roots). Elements read state and
// dispatch actions only.

import type { StoreView } from '@otter-player/core';
import type { MediaActionMap, MediaState, ThumbnailProvider } from '@otter-player/media';
import type { PresentationActionMap, PresentationState } from '@otter-player/presentation';
import type { QoeState } from '@otter-player/qoe';
import type { TextActionMap, TextState } from '@otter-player/text';
import type { ChromeActionMap, ChromeState } from './chrome.js';

/**
 * State the primitives read: the media session plus whatever the shell added. `qoe` is optional
 * (the stats panel shows what is available); text / chrome / presentation slices may be absent.
 */
export type UiState = MediaState &
  Partial<QoeState> &
  Partial<TextState> &
  Partial<ChromeState> &
  Partial<PresentationState>;
export type UiActions = MediaActionMap & ChromeActionMap & TextActionMap & PresentationActionMap;
export type UiStore = StoreView<UiState, UiActions>;

const stores = new WeakMap<Node, UiStore>();

/** Elements that want to be told when a store becomes available on an ancestor. */
export interface StoreConsumer {
  connectStore(): void;
}

const isConsumer = (n: unknown): n is StoreConsumer =>
  typeof n === 'object' && n !== null && typeof (n as Partial<StoreConsumer>).connectStore === 'function';

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

export function findStore(from: Node): UiStore | undefined {
  return lookup(stores, from);
}

const thumbnails = new WeakMap<Node, ThumbnailProvider>();

/** Seek-preview pictures for the progress bar's card (ADR-007 §7); null removes them. */
export function provideThumbnails(root: HTMLElement, provider: ThumbnailProvider | null): void {
  if (provider === null) thumbnails.delete(root);
  else thumbnails.set(root, provider);
}

export function findThumbnails(from: Node): ThumbnailProvider | undefined {
  return lookup(thumbnails, from);
}
