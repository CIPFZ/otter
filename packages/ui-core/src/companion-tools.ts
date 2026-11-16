// Companion mode controls in the window (ADR-016, owner 2026-11-16), an on-demand chunk loaded when
// the player enters the companion window. A small cluster at the top right, shown with the
// controls (on hover or focus): a dimming slider with five steps (0 / 20 / 40 / 60 / 80 %) and the
// audio strip switch. In the audio strip a "show picture" button sits in the bar instead. No size
// setting: the viewer drags the window's edge. The rules go into the window's document only.

import { AudioLines, Image, Moon } from 'lucide';
import type { Unsubscribe } from '@otter-player/core';
import type { UiState, UiStore } from './context.js';
import type { IconNode } from './icons.js';
import { companionStrings } from './companion-strings.js';
import type { UiStrings } from './strings.js';

/**
 * What the main chunk lends this one: a value import of a module the main chunk also uses would
 * make that module a shared chunk loaded with the first screen (as settings-level.ts does).
 */
export interface CompanionToolsDeps {
  readonly icon: (node: IconNode) => string;
  readonly strings: UiStrings;
}

/** The dimming steps (the dim layer's cap is 0.8). */
const STEPS = [0, 0.2, 0.4, 0.6, 0.8] as const;
const stepOf = (dim: number): number => Math.max(0, Math.min(STEPS.length - 1, Math.round(dim / 0.2)));

const CSS = `[data-otter-companion-tools] { position: absolute; top: 8px; right: 8px; z-index: 3; display: flex; align-items: center; gap: 6px;
  padding: 2px 4px 2px 10px; border-radius: 999px; background: rgb(0 0 0 / 0.55); color: var(--otter-fg, #fff);
  font: 600 12px/1 var(--otter-font, system-ui, sans-serif); transition: opacity var(--otter-t-show, 0.2s) ease-out; }
[data-otter-companion-tools][data-idle], [data-otter-audio-only] [data-otter-companion-tools] { opacity: 0; pointer-events: none; }
[data-otter-companion-tools] svg { width: 16px; height: 16px; flex: none; }
.ot-dim { display: flex; align-items: center; gap: 6px; height: 28px; cursor: pointer; outline: none; touch-action: none; }
.ot-dim:focus-visible { box-shadow: 0 0 0 2px var(--otter-accent, #1ee9e6); border-radius: 6px; }
.ot-track { position: relative; width: 84px; height: 16px; }
.ot-rail, .ot-fill { position: absolute; left: 0; top: 7px; height: 2px; border-radius: 1px; }
.ot-rail { right: 0; background: rgb(255 255 255 / 0.35); }
.ot-fill { background: var(--otter-accent, #1ee9e6); }
.ot-tick { position: absolute; top: 6px; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: rgb(255 255 255 / 0.7); }
.ot-thumb { position: absolute; top: 3px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgb(0 0 0 / 0.3); }
.ot-val { min-width: 3ch; text-align: right; font-variant-numeric: tabular-nums; }
[data-otter-companion-tools] button, [data-otter-show-picture] { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px;
  padding: 0; border: 0; border-radius: 50%; background: none; color: inherit; cursor: pointer; }
[data-otter-companion-tools] button:focus-visible, [data-otter-show-picture]:focus-visible { outline: 2px solid var(--otter-accent, #1ee9e6); outline-offset: 1px; }
[data-otter-show-picture] { display: none; width: var(--otter-control-size, 32px); height: var(--otter-control-size, 32px); color: var(--otter-fg, #fff); }
[data-otter-show-picture] svg { width: var(--otter-icon-size, 20px); height: var(--otter-icon-size, 20px); }
[data-otter-audio-only] [data-otter-show-picture] { display: inline-flex; }`;

/**
 * Puts the companion controls into `root` (in the PiP window's document) and keeps them in step
 * with the store; returns their removal.
 */
export function mountCompanionTools(root: HTMLElement, store: UiStore, deps: CompanionToolsDeps): Unsubscribe {
  const { icon } = deps;
  const doc = root.ownerDocument;
  const t = companionStrings(deps.strings);
  if (doc.querySelector('style[data-otter-companion-tools-style]') === null) {
    const style = doc.createElement('style');
    style.setAttribute('data-otter-companion-tools-style', '');
    style.textContent = CSS;
    doc.head.append(style);
  }
  const tools = doc.createElement('div');
  tools.setAttribute('data-otter-companion-tools', '');
  const ticks = STEPS.map((_, i) => `<span class="ot-tick" style="left:${i * 25}%"></span>`).join('');
  tools.innerHTML = `<div class="ot-dim" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="80">${icon(Moon)}<span class="ot-track"><span class="ot-rail"></span><span class="ot-fill"></span>${ticks}<span class="ot-thumb"></span></span><span class="ot-val" aria-hidden="true"></span></div><button type="button" class="ot-strip">${icon(AudioLines)}</button>`;
  const slider = tools.querySelector('.ot-dim') as HTMLElement;
  const track = tools.querySelector('.ot-track') as HTMLElement;
  const fill = tools.querySelector('.ot-fill') as HTMLElement;
  const thumb = tools.querySelector('.ot-thumb') as HTMLElement;
  const value = tools.querySelector('.ot-val') as HTMLElement;
  const strip = tools.querySelector('.ot-strip') as HTMLButtonElement;
  slider.setAttribute('aria-label', t.dim);
  strip.setAttribute('aria-label', t.audioOnly);
  strip.title = t.audioOnly;

  const show = doc.createElement('button');
  show.type = 'button';
  show.setAttribute('data-otter-show-picture', '');
  show.setAttribute('aria-label', t.showPicture);
  show.title = t.showPicture;
  show.innerHTML = icon(Image);
  // In the bar, just before the way back to the page.
  const pip = root.querySelector('[data-otter-controls] otter-pip-button');
  if (pip !== null) pip.before(show);
  else root.querySelector('[data-otter-controls]')?.append(show);
  root.append(tools);

  const trigger = { type: 'input', source: 'otter-companion-tools' };
  const current = (): number => stepOf(store.getState().presentation?.companion?.dim ?? 0.4);
  const set = (step: number): void => {
    const next = Math.max(0, Math.min(STEPS.length - 1, step));
    if (next !== current()) store.dispatch('companion-set', { dim: STEPS[next] as number }, trigger);
  };
  const fromPointer = (e: PointerEvent): void => {
    const r = track.getBoundingClientRect();
    set(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / (r.width || 1))) * (STEPS.length - 1)));
  };
  const down = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    slider.setPointerCapture?.(e.pointerId);
    slider.focus({ preventScroll: true });
    fromPointer(e);
  };
  const move = (e: PointerEvent): void => {
    if (slider.hasPointerCapture?.(e.pointerId) === true) fromPointer(e);
  };
  const key = (e: KeyboardEvent): void => {
    const step = current();
    const to = { ArrowLeft: step - 1, ArrowDown: step - 1, PageDown: step - 1, ArrowRight: step + 1, ArrowUp: step + 1, PageUp: step + 1, Home: 0, End: STEPS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    set(to);
  };
  const wheel = (e: WheelEvent): void => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    set(current() + (e.deltaY < 0 ? 1 : -1));
  };
  const toStrip = (): void => void store.dispatch('companion-set', { audioOnly: true }, { type: 'click', source: 'otter-companion-tools' });
  const toPicture = (): void => void store.dispatch('companion-set', { audioOnly: false }, { type: 'click', source: 'otter-companion-tools' });
  slider.addEventListener('pointerdown', down);
  slider.addEventListener('pointermove', move);
  slider.addEventListener('keydown', key);
  slider.addEventListener('wheel', wheel, { passive: false });
  strip.addEventListener('click', toStrip);
  show.addEventListener('click', toPicture);

  const render = (s: Readonly<UiState>): void => {
    const c = s.presentation?.companion;
    const step = stepOf(c?.dim ?? 0.4);
    const pct = `${Math.round((STEPS[step] as number) * 100)}%`;
    const at = `${step * 25}%`;
    slider.setAttribute('aria-valuenow', String(Math.round((STEPS[step] as number) * 100)));
    slider.setAttribute('aria-valuetext', pct);
    fill.style.width = at;
    thumb.style.left = at;
    value.textContent = pct;
    // With the controls: shown on hover or focus (the player UI plugin), hidden otherwise.
    tools.toggleAttribute('data-idle', s.controlsVisible === false);
  };
  render(store.getState());
  const off = store.subscribe(render);

  return () => {
    off();
    tools.remove();
    show.remove();
  };
}
