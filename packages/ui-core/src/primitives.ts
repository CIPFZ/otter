// UI primitive elements (SPEC §14.1, ADR-005 §6). Each element binds one slice of store state to
// one piece of DOM and dispatches actions; none talks to the engine or the <video> (SPEC §3 rule
// 1). Text comes from the strings table, styling from --otter-* variables, ::part() and slots.
//
// Constructors live inside defineElements() so nothing extends HTMLElement at module top level
// (Workers / SSR, AGENT §4).

import type { Unsubscribe } from '@otter-player/core';
import { findStore, type StoreConsumer, type UiState, type UiStore } from './context.js';
import { findStrings, type UiStrings } from './strings.js';

export { speakTime } from './format.js';

export const BUTTON_CSS = `
:host { display: inline-flex; }
:host([hidden]), :host([data-otter-unsupported]) { display: none; }
button {
  all: unset; box-sizing: border-box; cursor: pointer;
  min-width: var(--otter-control-size, 44px); min-height: var(--otter-control-size, 44px);
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--otter-fg, #fff); border-radius: var(--otter-radius, 8px);
  font: var(--otter-font, 600 14px/1 system-ui, sans-serif);
}
button:focus-visible, :host(:focus-visible) { outline: 3px solid var(--otter-accent, #1ee9e6); outline-offset: 2px; }
button:disabled { opacity: 0.5; cursor: default; }
button[aria-pressed="true"] { color: var(--otter-accent, #1ee9e6); }
svg { width: 24px; height: 24px; fill: currentColor; }
`;

export const SLIDER_CSS = `
:host { display: flex; align-items: center; flex: 1; min-width: 80px; }
:host([hidden]), :host([data-otter-unsupported]) { display: none; }
input { width: 100%; margin: 0; height: var(--otter-control-size, 44px); background: transparent;
  accent-color: var(--otter-accent, #1ee9e6); cursor: pointer; }
input:focus-visible { outline: 3px solid var(--otter-accent, #1ee9e6); outline-offset: 2px; }
input:disabled { cursor: default; }
`;

// evenodd: icons with holes (captions bars, PiP frame) are drawn as one path.
export const svg = (path: string): string => `<svg viewBox="0 0 24 24" fill-rule="evenodd" aria-hidden="true" focusable="false">${path}</svg>`;

export const ICON = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  volume: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>',
  volumeLow: '<path d="M5 9v6h4l5 5V4L9 9H5z"/>',
  muted: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/>',
  captions: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm2 8h4v2H6zm8 0h4v2h-4zM6 9h3v2H6zm9 0h3v2h-3z"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9.4 5.4-1.7-.3a7.6 7.6 0 0 0-.8-2l1-1.4-2.6-2.6-1.4 1a7.6 7.6 0 0 0-2-.8L13.6 5h-3.2l-.3 1.9a7.6 7.6 0 0 0-2 .8L6.7 6.7 4.1 9.3l1 1.4a7.6 7.6 0 0 0-.8 2l-1.9.3v3.2l1.9.3a7.6 7.6 0 0 0 .8 2l-1 1.4 2.6 2.6 1.4-1a7.6 7.6 0 0 0 2 .8l.3 1.9h3.2l.3-1.9a7.6 7.6 0 0 0 2-.8l1.4 1 2.6-2.6-1-1.4a7.6 7.6 0 0 0 .8-2l1.9-.3z"/>',
  fullscreen: '<path d="M5 5h5V3H3v7h2zm9-2v2h5v5h2V3zM5 14H3v7h7v-2H5zm14 5h-5v2h7v-7h-2z"/>',
  exitFullscreen: '<path d="M8 3v5H3v2h7V3zM16 3v7h5V8h-5V3zM3 14v2h5v5h2v-7zm16 0h-5v7h2v-5h3z"/>',
  pip: '<path d="M3 5h18v14H3zM5 7v10h14V7z"/><path d="M12 11h6v5h-6z"/>',
  live: '<path d="M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0-4a6 6 0 0 1 6 6 6 6 0 0 1-6 6 6 6 0 0 1-6-6 6 6 0 0 1 6-6z"/>',
} as const;

/** Shared lifecycle: find the store and strings, subscribe while connected, render on change. */
export function createBase(): abstract new () => HTMLElement & StoreConsumer & { readonly ui: UiStore | undefined; readonly strings: UiStrings } {
  abstract class OtterElement extends HTMLElement implements StoreConsumer {
    #store: UiStore | undefined;
    #off: Unsubscribe | undefined;
    get ui(): UiStore | undefined {
      return this.#store;
    }
    get strings(): UiStrings {
      return findStrings(this);
    }
    connectedCallback(): void {
      this.setup();
      this.connectStore();
    }
    disconnectedCallback(): void {
      this.#off?.();
      this.#off = undefined;
      this.#store = undefined;
    }
    connectStore(): void {
      if (this.#off !== undefined || !this.isConnected) return;
      const store = findStore(this);
      if (store === undefined) return;
      this.#store = store;
      this.#off = store.subscribe((s: Readonly<UiState>) => this.render(s));
      this.render(store.getState());
    }
    protected abstract setup(): void;
    protected abstract render(state: Readonly<UiState>): void;
  }
  return OtterElement;
}

export type OtterBase = ReturnType<typeof createBase>;

/** Hides an element the state does not support (skins may also style [data-otter-unsupported]). */
export const unsupported = (el: HTMLElement, yes: boolean): void => {
  if (yes) el.setAttribute('data-otter-unsupported', '');
  else el.removeAttribute('data-otter-unsupported');
};

/** `aria-valuetext` for a 0..1 volume. */
export const speakVolume = (v: number): string => `${Math.round(v * 100)}%`;

