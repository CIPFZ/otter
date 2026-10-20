// Error card view (UI-DESIGN §10), an on-demand chunk the <otter-error> element loads the first
// time playback fails: icon, title, error type and details, and a retry of the same source.

import { CircleAlert } from 'lucide';
import type { UiState } from './context.js';
import type { IconNode } from './icons.js';
import type { T as Tokens } from './primitives.js';
import type { UiStrings } from './strings.js';

/** Helpers owned by the main chunk (a value import of them would make a shared chunk). */
export interface ErrorDeps {
  readonly T: typeof Tokens;
  readonly glass: () => string;
  readonly glassFallback: (selector: string) => string;
  readonly icon: (node: IconNode) => string;
}

/** Builds the card in `root`; returns its render function. `retry` reloads the source. */
export function mountErrorCard(root: ShadowRoot, strings: () => UiStrings, retry: (e: Event) => void, d: ErrorDeps): (s: Readonly<UiState>) => void {
  const { T } = d;
  root.innerHTML = `<style>:host { position: absolute; inset: 0; display: grid; place-items: center; }
:host([hidden]) { display: none; }
.card { display: grid; justify-items: center; gap: 8px; max-width: min(360px, 80%); padding: 20px 24px; border-radius: ${T.radiusLg};
  ${d.glass()} color: ${T.fg}; font: 500 14px/1.4 ${T.font}; text-align: center; }
svg { width: 32px; height: 32px; color: ${T.danger}; }
.detail { color: ${T.muted}; font-size: 12px; font-family: ${T.mono}; }
button { all: unset; cursor: pointer; margin-top: 4px; padding: 8px 16px; border-radius: 999px; background: ${T.fg}; color: #10161e;
  font: 600 13px/1 ${T.font}; }
button:focus-visible { outline: 2px solid ${T.accentDeep}; outline-offset: 2px; }
${d.glassFallback('.card')}</style><div class="card" part="card" role="alert">${d.icon(CircleAlert)}<span class="t" part="title"></span><span class="detail" part="detail"></span><button part="retry" type="button"></button></div>`;
  const title = root.querySelector('.t') as HTMLElement;
  const detail = root.querySelector('.detail') as HTMLElement;
  const button = root.querySelector('button') as HTMLButtonElement;
  button.addEventListener('click', retry);
  return (s) => {
    const t = strings();
    title.textContent = t.errorTitle;
    detail.textContent = `${s.error?.type ?? ''} · ${s.error?.details ?? ''}`;
    button.textContent = t.retry;
  };
}
