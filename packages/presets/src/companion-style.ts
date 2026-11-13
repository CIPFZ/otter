// The default shell in the companion window (ADR-016 §4, an on-demand chunk loaded on entering it):
// a slim control bar (play / pause, mute, progress and time, settings, back to the page), no top
// bar or centre buttons. The rules go into the Document PiP window's document only and key on the
// root's `data-otter-companion` mark, so nothing is added to the page; they go with the window.

// The page's style sheets are copied into the window (docpip.ts), the host's body padding and
// player box sizing included: in the companion window the player fills it.
const CSS = `body { margin: 0 !important; padding: 0 !important; overflow: hidden; background: #000; }
[data-otter-companion] { position: fixed !important; inset: 0 !important; width: auto !important; height: auto !important; max-width: none !important; aspect-ratio: auto !important; }
[data-otter-companion] > :is([data-otter-top], [data-otter-center], otter-big-play, otter-mini-close) { display: none; }
[data-otter-companion] [data-otter-controls] :is(otter-quality-menu, otter-speed-menu, otter-captions-button, otter-cast-button, otter-airplay-button, otter-theater-button, otter-fullscreen-button, otter-volume-slider) { display: none; }
[data-otter-companion] [data-otter-controls] otter-pip-button:not([data-otter-unsupported], [hidden]) { display: inline-flex; }`;

/** Adds the companion rules to `doc` once (the PiP window's document). */
export function addCompanionStyle(doc: Document): void {
  if (doc.querySelector('style[data-otter-companion-style]') !== null) return;
  const style = doc.createElement('style');
  style.setAttribute('data-otter-companion-style', '');
  style.textContent = CSS;
  doc.head.append(style);
}
