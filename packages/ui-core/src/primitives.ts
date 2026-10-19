// Shared base and styles of the UI primitives (SPEC §14.1, UI-DESIGN §4 / §10). Every value
// comes from a --otter-* design token; the fallbacks here equal the default skin's values, so
// primitives look right even without a skin. Store lifecycle lives in createBase().

import type { Unsubscribe } from '@otter-player/core';
import { findStore, type StoreConsumer, type UiState, type UiStore } from './context.js';
import { findStrings, type UiStrings } from './strings.js';

export { speakTime } from './format.js';

/** Token fallbacks (UI-DESIGN §4). */
export const T = {
  fg: 'var(--otter-fg, rgb(255 255 255 / 0.92))',
  muted: 'var(--otter-fg-muted, rgb(255 255 255 / 0.64))',
  dim: 'var(--otter-fg-dim, rgb(255 255 255 / 0.4))',
  accent: 'var(--otter-accent, #1ee9e6)',
  accentDeep: 'var(--otter-accent-deep, #12c9d4)',
  live: 'var(--otter-live, #ff4d4f)',
  danger: 'var(--otter-danger, #ff6b6b)',
  glass: 'var(--otter-glass, rgb(18 22 30 / 0.88))',
  glassBorder: 'var(--otter-glass-border, rgb(255 255 255 / 0.08))',
  hover: 'var(--otter-hover, rgb(255 255 255 / 0.1))',
  track: 'var(--otter-track, rgb(255 255 255 / 0.22))',
  buffered: 'var(--otter-buffered-color, rgb(255 255 255 / 0.45))',
  font: 'var(--otter-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif)',
  mono: 'var(--otter-font-mono, ui-monospace, "SF Mono", Menlo, Consolas, monospace)',
  shadow: 'var(--otter-shadow-pop, 0 8px 32px rgb(0 0 0 / 0.45), 0 1px 0 rgb(255 255 255 / 0.06) inset)',
  textShadow: 'var(--otter-text-shadow, 0 1px 2px rgb(0 0 0 / 0.6))',
  easeOut: 'var(--otter-ease-out, cubic-bezier(0.2, 0, 0, 1))',
  easeIn: 'var(--otter-ease-in, cubic-bezier(0.4, 0, 1, 1))',
  fast: 'var(--otter-t-fast, 120ms)',
  show: 'var(--otter-t-show, 150ms)',
  hide: 'var(--otter-t-hide, 250ms)',
  size: 'var(--otter-control-size, 40px)',
  icon: 'var(--otter-icon-size, 24px)',
  radiusSm: 'var(--otter-radius-sm, 4px)',
  radius: 'var(--otter-radius, 8px)',
  radiusLg: 'var(--otter-radius-lg, 12px)',
} as const;

/**
 * Glass material (UI-DESIGN §4.1, ADR-006): blur where supported, otherwise a near-opaque fill.
 * Styles are functions: module-level strings built from T would be top-level side effects.
 */
export const glass = (): string => `background: ${T.glass}; border: 1px solid ${T.glassBorder}; box-shadow: ${T.shadow};
  -webkit-backdrop-filter: blur(var(--otter-glass-blur, 16px)); backdrop-filter: blur(var(--otter-glass-blur, 16px));`;
/** ADR-006 degradation: without backdrop-filter the glass fill goes to 0.96 opacity. */
export const glassFallback = (selector: string): string =>
  `@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { ${selector} { background: var(--otter-glass-solid, rgb(18 22 30 / 0.96)); } }`;

export const REDUCED_MOTION: string = `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; } }`;

export const buttonCss = (): string => `
:host { display: inline-flex; position: relative; }
:host([hidden]), :host([data-otter-unsupported]) { display: none; }
button {
  all: unset; box-sizing: border-box; cursor: pointer; position: relative;
  min-width: ${T.size}; height: ${T.size};
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  color: ${T.fg}; border-radius: ${T.radius}; font: 600 13px/1 ${T.font}; text-shadow: ${T.textShadow};
  -webkit-tap-highlight-color: transparent;
}
button svg { width: ${T.icon}; height: ${T.icon}; filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.45));
  transition: opacity ${T.fast} ${T.easeOut}, transform ${T.fast} ${T.easeOut}; }
.icon { display: grid; }
.icon > svg { grid-area: 1 / 1; }
.icon > svg:not([data-on]) { opacity: 0; transform: scale(0.85); }
button:hover .icon > svg[data-on] { transform: scale(1.1); }
button:active .icon > svg[data-on] { transform: scale(0.95); }
button:focus-visible { outline: 2px solid ${T.accentDeep}; outline-offset: 2px; }
button:disabled { opacity: 0.4; cursor: default; }
button:disabled .icon > svg[data-on] { transform: none; }
.text { padding: 0 8px; }
button[aria-pressed="true"]::after { content: ''; position: absolute; left: 30%; right: 30%; bottom: 5px; height: 2px;
  border-radius: 1px; background: ${T.accent}; }
.tip { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); padding: 4px 8px;
  border-radius: ${T.radiusSm}; ${glass()} color: ${T.fg}; font: 500 11px/1.3 ${T.font}; white-space: nowrap;
  pointer-events: none; opacity: 0; transition: opacity ${T.fast} ${T.easeOut}; text-shadow: none; z-index: 1; }
:host(:hover) .tip { opacity: 1; transition-delay: 400ms; }
:host([data-tip-align="end"]) .tip { left: auto; right: 0; transform: none; }
:host([data-tip-align="start"]) .tip { left: 0; transform: none; }
@media (hover: none) { .tip { display: none; } }
${glassFallback('.tip')}
${REDUCED_MOTION}
`;

/** Native range input over a drawn rail (UI-DESIGN §6.2); the input keeps all slider semantics. */
export const rangeCss = (): string => `
.range { position: relative; height: var(--otter-hit, 24px); }  /* WCAG 2.5.8: 24 px target, 3 px drawn */
input { -webkit-appearance: none; appearance: none; position: absolute; inset: 0; width: 100%; height: 100%; margin: 0;
  background: transparent; cursor: pointer; }
input:disabled { cursor: default; }
input:focus-visible { outline: 2px solid ${T.accentDeep}; outline-offset: 2px; border-radius: ${T.radiusSm}; }
input::-webkit-slider-runnable-track { height: 100%; background: transparent; }
input::-moz-range-track { height: 100%; background: transparent; }
input::-moz-range-progress { background: transparent; }
input::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: var(--otter-thumb, 13px); height: var(--otter-thumb, 13px);
  border-radius: 50%; background: ${T.accent}; box-shadow: 0 0 0 2px rgb(0 0 0 / 0.35);
  transform: scale(var(--otter-thumb-scale, 0)); transition: transform ${T.fast} ${T.easeOut}; }
input::-moz-range-thumb { width: var(--otter-thumb, 13px); height: var(--otter-thumb, 13px); border: none; border-radius: 50%;
  background: ${T.accent}; box-shadow: 0 0 0 2px rgb(0 0 0 / 0.35); transform: scale(var(--otter-thumb-scale, 0));
  transition: transform ${T.fast} ${T.easeOut}; }
input:focus-visible, .range:hover input { --otter-thumb-scale: 1; }
.rail { position: absolute; left: 0; right: 0; top: 50%; height: var(--otter-rail, 3px); transform: translateY(-50%);
  border-radius: 999px; background: ${T.track}; overflow: hidden; pointer-events: none; transition: height ${T.fast} ${T.easeOut}; }
.rail > i { position: absolute; top: 0; bottom: 0; left: 0; border-radius: inherit; }
.buffered { background: ${T.buffered}; width: var(--otter-buffered, 0%); }
.played { background: ${T.accent}; width: var(--otter-played, 0%); }
${REDUCED_MOTION}
`;

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
