// Live views (UI-DESIGN §10), an on-demand chunk loaded when the source is live (ADR-011 §2):
// - <otter-live-indicator>: the "Live" badge with how far behind the live edge ("−6.0 s"), and the
//   "Back to live" capsule once more than 3 s past the engine's target latency;
// - <otter-time-slider> (DVR): the seekable window as the range, the fill and the preview labels as
//   distance behind the edge. The edge is the engine's (state.latency: currentTime + latency).

import type { UiState, UiStore } from './context.js';
import type { IconNode } from './icons.js';
import type { T as Tokens } from './primitives.js';
import type { UiStrings } from './strings.js';

/** How far behind the live edge: "−6.2 s" below a minute (tenths), else "−1:20". */
export const formatBehind = (seconds: number): string => {
  const s = Math.max(0, seconds);
  return `−${s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`}`;
};

/** Renders the time slider for live (`value`: a position being dragged). */
export type LiveSlider = (s: Readonly<UiState>, dragging: boolean, value?: number) => void;

/**
 * The time slider's live mode: [seekableStart, seekableEnd] as the range (disabled with less than
 * a second of window), the played fill, aria-valuetext "Behind live 12 seconds", and the preview
 * card's label (`label`) as distance behind the edge.
 */
export function liveSlider(
  host: HTMLElement,
  input: HTMLInputElement,
  strings: () => UiStrings,
  label: (format: (time: number) => string) => void,
  speakTime: (seconds: number, words: UiStrings) => string,
  setFill: (el: HTMLElement, name: 'played' | 'buffered', fraction: number) => void,
): LiveSlider {
  let edge = 0;
  const fillTo = (name: 'played' | 'buffered', f: number): void => setFill(host, name, f);
  label((time) => formatBehind(edge - time));
  return (s, dragging, value) => {
    const min = s.seekableStart ?? 0;
    const max = s.seekableEnd ?? 0;
    edge = s.currentTime + (s.latency ?? Math.max(0, max - s.currentTime));
    input.disabled = !(max - min > 1);
    if (input.disabled) return;
    if (input.min !== String(min)) input.min = String(min);
    if (input.max !== String(max)) input.max = String(max);
    const at = value ?? s.currentTime;
    if (!dragging || value !== undefined) {
      if (value === undefined) input.value = String(at);
      input.setAttribute('aria-valuetext', `${strings().behindLive} ${speakTime(edge - at, strings())}`);
      fillTo('played', (at - min) / (max - min));
    }
    fillTo('buffered', (s.bufferedEnd - min) / (max - min));
  };
}

/** Helpers owned by the main chunk (a value import of them would make a shared chunk). */
export interface LiveDeps {
  readonly T: typeof Tokens;
  readonly icon: (node: IconNode) => string;
  readonly LiveDot: IconNode;
}

/** Builds the indicator in `root`; returns its render function. */
export function mountLiveIndicator(host: HTMLElement, root: ShadowRoot, ui: () => UiStore | undefined, strings: () => UiStrings, d: LiveDeps): (s: Readonly<UiState>) => void {
  const { T } = d;
  root.innerHTML = `<style>
:host { display: inline-flex; align-items: center; }
:host([hidden]), :host([data-otter-unsupported]) { display: none; }
.badge, button { display: inline-flex; align-items: center; gap: 6px; height: 24px; font: 600 13px/1 ${T.font}; color: ${T.fg};
  text-shadow: ${T.textShadow}; white-space: nowrap; }
.badge svg, button svg { width: 8px; height: 8px; color: ${T.live}; }
.badge[hidden], button[hidden] { display: none; }
button { all: unset; display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px;
  border: 1px solid ${T.accent}; cursor: pointer; font: 600 13px/1 ${T.font}; color: ${T.fg}; }
button svg { color: ${T.dim}; }
button:hover { background: ${T.hover}; }
button:focus-visible { outline: 2px solid ${T.accentDeep}; outline-offset: 2px; }
i { font-style: normal; font-weight: 500; color: ${T.muted}; font-variant-numeric: tabular-nums; }
</style><span class="badge" part="badge" role="status">${d.icon(d.LiveDot)}<b part="label" style="font-weight:inherit"></b><i part="behind" aria-hidden="true"></i></span><button part="back-to-live" type="button" hidden>${d.icon(d.LiveDot)}<span></span><i part="behind" aria-hidden="true"></i></button>`;
  const badge = root.querySelector('.badge') as HTMLElement;
  const button = root.querySelector('button') as HTMLButtonElement;
  button.addEventListener('click', (e) => {
    // One gesture: back to the edge, and play if paused (SPEC §3 rule 3).
    const trigger = { type: e.type, source: 'otter-live-indicator' };
    const store = ui();
    store?.dispatch('seek-to-live', {}, trigger);
    if (store?.getState().paused === true) store.dispatch('play', undefined, trigger);
  });
  return (s) => {
    const t = strings();
    // More than 3 s past the engine's own target (HLS HOLD-BACK; FLV ~1 s) is "behind".
    const behind = s.live && s.latency !== null && s.latency > (s.targetLatency ?? 0) + 3;
    // How far behind the live edge, in both forms; visual only (the status would be announced 4
    // times a second; the time slider speaks it as "Behind live 6 seconds").
    const seconds = s.latency === null ? '' : formatBehind(s.latency);
    for (const el of root.querySelectorAll('i')) if (el.textContent !== seconds) el.textContent = seconds;
    host.toggleAttribute('behind', behind);
    badge.hidden = behind;
    button.hidden = !behind;
    const label = badge.querySelector('b') as HTMLElement;
    if (label.textContent !== t.live) label.textContent = t.live;
    const text = button.querySelector('span') as HTMLElement;
    if (text.textContent !== t.backToLive) text.textContent = t.backToLive;
  };
}
