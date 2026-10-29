// The default player shell (SPEC §13, UI-DESIGN): the markup of the controls around a <video>,
// built inside the host's container. The ui-core elements render themselves once defined; the
// skin is the host's stylesheet (`@otter-player/ui-skin-default`).

import { findStrings } from '@otter-player/ui-core';

/** Markup of the default shell (controls, centre buttons, top bar, feedback, error, stats). */
const SHELL = `<video playsinline crossorigin="anonymous" tabindex="-1"></video>
<otter-gesture></otter-gesture><otter-poster></otter-poster><otter-big-play></otter-big-play><otter-spinner></otter-spinner><otter-feedback></otter-feedback><otter-error></otter-error>
<div data-otter-top><span data-otter-title></span></div>
<div data-otter-center><otter-seek-button seconds="-10"></otter-seek-button><otter-play-button></otter-play-button><otter-seek-button seconds="10"></otter-seek-button></div>
<otter-stats hidden></otter-stats><otter-announcer></otter-announcer><otter-mini-close></otter-mini-close>
<div data-otter-controls><otter-time-slider></otter-time-slider>
<div data-otter-group="left"><otter-play-button data-tip-align="start"></otter-play-button><div data-otter-volume><otter-mute-button></otter-mute-button><otter-volume-slider></otter-volume-slider></div><otter-time-display></otter-time-display><otter-live-indicator></otter-live-indicator></div>
<div data-otter-group="right"><otter-quality-menu></otter-quality-menu><otter-speed-menu></otter-speed-menu><otter-captions-button></otter-captions-button><otter-settings-menu></otter-settings-menu><otter-cast-button></otter-cast-button><otter-airplay-button></otter-airplay-button><otter-pip-button></otter-pip-button><otter-theater-button></otter-theater-button><otter-fullscreen-button data-tip-align="end"></otter-fullscreen-button></div></div>`;

/**
 * The player root: `container` itself, marked as the player. A container that already holds a
 * <video> keeps its markup (the host's own shell); an empty one gets the default shell
 * (`controls`) or a bare <video>.
 */
export function buildShell(container: HTMLElement, controls: boolean, title: string | undefined): HTMLVideoElement {
  container.setAttribute('data-otter-player', '');
  if (!container.hasAttribute('role')) container.setAttribute('role', 'region');
  if (!container.hasAttribute('aria-label')) container.setAttribute('aria-label', findStrings(container).player);
  // The root takes keyboard focus for hotkeys (the picture itself is not a control).
  if (!container.hasAttribute('tabindex')) container.tabIndex = -1;
  let video = container.querySelector('video');
  if (video === null) {
    if (controls) container.innerHTML = SHELL;
    else container.innerHTML = '<video playsinline crossorigin="anonymous" tabindex="-1"></video>';
    video = container.querySelector('video') as HTMLVideoElement;
  }
  const titleEl = container.querySelector('[data-otter-title]');
  if (titleEl !== null && title !== undefined) titleEl.textContent = title;
  return video;
}
