// Live indicator view (UI-DESIGN §10), an on-demand chunk <otter-live-indicator> loads when the
// source is live: the "Live" badge, and the "Back to live" capsule once more than 3 s behind.

import type { UiState, UiStore } from './context.js';
import type { IconNode } from './icons.js';
import type { T as Tokens } from './primitives.js';
import type { UiStrings } from './strings.js';

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
</style><span class="badge" part="badge" role="status">${d.icon(d.LiveDot)}<b part="label" style="font-weight:inherit"></b></span><button part="back-to-live" type="button" hidden>${d.icon(d.LiveDot)}<span></span></button>`;
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
    const behind = s.live && s.latency !== null && s.latency > 3;
    host.toggleAttribute('behind', behind);
    badge.hidden = behind;
    button.hidden = !behind;
    const label = badge.querySelector('b') as HTMLElement;
    if (label.textContent !== t.live) label.textContent = t.live;
    const text = button.querySelector('span') as HTMLElement;
    if (text.textContent !== t.backToLive) text.textContent = t.backToLive;
  };
}
