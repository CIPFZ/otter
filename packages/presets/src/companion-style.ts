// The default shell in the companion window (ADR-016 §4), an on-demand chunk loaded on entering it.
// - A slim control bar (play / pause, mute, progress and time, settings, back to the page); no top
//   bar or centre buttons.
// - The audio strip (`data-otter-audio-only`): no picture layers and no settings; the bar always
//   shown (the player UI plugin keeps it visible), with smaller buttons so the progress row and the
//   button row fit 66 px. Windows up to 300 px wide get the smaller buttons too: the s step opens
//   248 px wide on Edge 157, where the five controls wrapped onto a second row.
// - The settings panel is a sheet over the window (8 px margins), not a popup above its button: a
//   240-440 px window has no room beside or above the bar for it.
// The rules go into the Document PiP window's document only and key on the root's
// `data-otter-companion` mark, so nothing is added to the page; they go with the window.

// The player fills the window in any Document PiP (docpip.ts).
const CSS = `[data-otter-companion] > :is([data-otter-top], [data-otter-center], otter-big-play, otter-mini-close) { display: none; }
[data-otter-companion] [data-otter-controls] :is(otter-quality-menu, otter-speed-menu, otter-captions-button, otter-cast-button, otter-airplay-button, otter-theater-button, otter-fullscreen-button, otter-volume-slider) { display: none; }
[data-otter-companion] [data-otter-controls] otter-pip-button:not([data-otter-unsupported], [hidden]) { display: inline-flex; }
[data-otter-audio-only] > :is(video, canvas, otter-poster, otter-gesture, otter-spinner, otter-feedback, [data-otter-overlays]) { display: none !important; }
[data-otter-audio-only] [data-otter-controls] otter-settings-menu { display: none; }
[data-otter-audio-only] [data-otter-controls]::before { display: none; }
[data-otter-companion] otter-settings-menu::part(menu) { position: fixed; inset: 8px 8px auto 8px; width: auto; max-height: calc(100vh - 16px); }
[data-otter-audio-only] { --otter-control-size: 32px; --otter-icon-size: 20px; --otter-bar-height: 36px; }
@media (max-width: 300px) { [data-otter-companion] { --otter-control-size: 32px; --otter-icon-size: 20px; --otter-bar-padding-x: 6px; } }`;

/** Adds the companion rules to `doc` once (the PiP window's document). */
export function addCompanionStyle(doc: Document): void {
  if (doc.querySelector('style[data-otter-companion-style]') !== null) return;
  const style = doc.createElement('style');
  style.setAttribute('data-otter-companion-style', '');
  style.textContent = CSS;
  doc.head.append(style);
}
