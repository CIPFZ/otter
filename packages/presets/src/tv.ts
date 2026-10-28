// Preset `tv` (SPEC §19「电视遥控器」): HLS (own engine) and DASH on MSE, driven by a remote: arrow
// keys move the focus between the controls (spatial navigation), OK activates, Back closes a menu
// or leaves the controls, media keys play / pause / seek. On the picture (nothing focused), Left /
// Right seek and Up / Down bring the controls up. The default skin until ui-skin-tv (M6 batch 4).

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDashFormat } from '@otter-player/format-dash';
import { createHlsFormat } from '@otter-player/format-hls';
import { DEFAULT_HOTKEYS, type HotkeyMap } from '@otter-player/input';
import type { PresetOptions } from './options.js';
import { createPlayer, type Player, type PlayerActions, type PlayerState } from './player.js';
import type { StoreView } from '@otter-player/core';

/** Remote keys on top of SPEC §14.3 (Up / Down are focus moves here, not volume: the TV has its own). */
export const TV_HOTKEYS: HotkeyMap = (() => {
  const { ArrowUp: _up, ArrowDown: _down, ...rest } = DEFAULT_HOTKEYS;
  return {
    ...rest,
    MediaPlayPause: { type: 'toggle-paused' },
    MediaPlay: { type: 'toggle-paused' },
    MediaPause: { type: 'toggle-paused' },
    MediaFastForward: { type: 'seek-by', seconds: 10 },
    MediaRewind: { type: 'seek-by', seconds: -10 },
  };
})();

export function createTvPlayer(options: PresetOptions): Player {
  return createPlayer({
    idleMs: 5000,
    hotkeys: TV_HOTKEYS,
    ...options,
    formats: [createHlsFormat(), createDashFormat()],
    backends: [createMseBackendFactory(), createNativeBackendFactory()],
    setup(parts) {
      const off = bindRemote(parts.root, parts.store);
      const more = options.setup?.(parts);
      return () => {
        off();
        more?.();
      };
    },
  });
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Elements that use the arrows themselves (sliders, menus): Left / Right stay theirs. */
const OWN_ARROWS = '[role="slider"], input[type="range"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';
/** Back on remotes: Tizen 10009, webOS 461, and the keys browsers name. */
const BACK_KEYS = new Set(['Escape', 'GoBack', 'BrowserBack', 'Backspace']);
const BACK_CODES = new Set([10009, 461]);

/** Visible focusable controls inside `root`, open shadow roots included. */
function focusables(root: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const visit = (node: Element | ShadowRoot): void => {
    for (const child of Array.from(node.children)) {
      if (child instanceof HTMLElement && child.matches(FOCUSABLE) && child.getAttribute('aria-hidden') !== 'true') {
        const r = child.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && child.closest('[hidden]') === null) out.push(child);
      }
      if (child.shadowRoot !== null) visit(child.shadowRoot);
      visit(child);
    }
  };
  visit(root);
  return out;
}

/** The focused element, through open shadow roots. */
function deepActive(doc: Document): Element | null {
  let a = doc.activeElement;
  while (a?.shadowRoot?.activeElement != null) a = a.shadowRoot.activeElement;
  return a;
}

/** The nearest control from `from` in a direction: along the axis first, sideways offset weighs double. */
function nearest(from: Element, list: readonly HTMLElement[], key: string): HTMLElement | undefined {
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: HTMLElement | undefined;
  let score = Number.POSITIVE_INFINITY;
  for (const el of list) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const dx = b.left + b.width / 2 - ax;
    const dy = b.top + b.height / 2 - ay;
    const [main, side] = key === 'ArrowLeft' ? [-dx, dy] : key === 'ArrowRight' ? [dx, dy] : key === 'ArrowUp' ? [-dy, dx] : [dy, dx];
    if (main <= 1) continue;
    const s = main + 2 * Math.abs(side);
    if (s < score) {
      score = s;
      best = el;
    }
  }
  return best;
}

/**
 * Remote navigation on the player root. Runs before the InputController (capture), which skips
 * keys already handled (defaultPrevented).
 */
export function bindRemote(root: HTMLElement, store: StoreView<PlayerState, PlayerActions>): () => void {
  const doc = root.ownerDocument;
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const active = deepActive(doc);
    const inside = active !== null && active !== root && root.contains(active instanceof Element && active.getRootNode() instanceof ShadowRoot ? (active.getRootNode() as ShadowRoot).host : active);
    if (BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode)) {
      if (e.key === 'Backspace' && active instanceof HTMLInputElement && active.type === 'text') return;
      e.preventDefault();
      // A menu closes first (the chrome's escape); with none open, the focus leaves the controls.
      const menu = store.getState().menu;
      store.dispatch('escape', {});
      if (menu == null && inside) root.focus();
      return;
    }
    if (!e.key.startsWith('Arrow')) return;
    if (!inside) {
      // On the picture: Up / Down bring the controls and focus the play button; Left / Right seek (hotkeys).
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        store.dispatch('show-controls', {});
        // The bar's play button (the time slider before it keeps Left / Right for seeking).
        const list = focusables(root);
        const host = (el: HTMLElement): Element => (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : el);
        const inBar = list.filter((el) => host(el).closest('[data-otter-controls]') !== null);
        (inBar.find((el) => host(el).tagName === 'OTTER-PLAY-BUTTON') ?? inBar[0])?.focus();
      }
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && active instanceof Element && active.closest(OWN_ARROWS) !== null) return;
    if (active instanceof Element && active.closest('[role="menu"], [role^="menuitem"]') !== null) return;
    e.preventDefault();
    store.dispatch('show-controls', {});
    const next = nearest(active as Element, focusables(root), e.key);
    if (next !== undefined) next.focus();
    else if (e.key === 'ArrowUp') root.focus();
  };
  root.addEventListener('keydown', onKey, true);
  return () => root.removeEventListener('keydown', onKey, true);
}
