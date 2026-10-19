// UI primitives and composites (SPEC §14.1 / §14.2, ADR-005 §6). Every control is a native
// <button> / <input type=range> or a complete ARIA pattern (menu + menuitemradio), has a visible
// focus ring and takes its text from the strings table. Clicks dispatch synchronously, so play,
// fullscreen and PiP keep their user activation (SPEC §3 rule 3).
//
// Classes are created inside defineOtterElements(), not at module top level: `extends HTMLElement`
// at top level would throw in Workers / SSR and is a top-level side effect (AGENT §4).

import type { UiState } from './context.js';
import { formatBitrate, formatMs, formatSeconds, formatTime } from './format.js';
import { BUTTON_CSS, createBase, ICON, SLIDER_CSS, speakTime, speakVolume, svg, unsupported } from './primitives.js';
import { fill, type UiStrings } from './strings.js';
import type { CaptionStyle } from '@otter-player/text';

export const M1_ELEMENTS = {
  PlayButton: 'otter-play-button',
  MuteButton: 'otter-mute-button',
  TimeDisplay: 'otter-time-display',
  TimeSlider: 'otter-time-slider',
  Stats: 'otter-stats',
} as const;

export const M2_ELEMENTS = {
  VolumeSlider: 'otter-volume-slider',
  LiveIndicator: 'otter-live-indicator',
  Menu: 'otter-menu',
  MenuItem: 'otter-menu-item',
  Tooltip: 'otter-tooltip',
  Gesture: 'otter-gesture',
  Poster: 'otter-poster',
  Spinner: 'otter-spinner',
  Announcer: 'otter-announcer',
  CaptionsButton: 'otter-captions-button',
  FullscreenButton: 'otter-fullscreen-button',
  PipButton: 'otter-pip-button',
  SettingsMenu: 'otter-settings-menu',
} as const;

export interface DefineOptions {
  readonly registry?: CustomElementRegistry;
}

/** One selectable entry of a menu group. */
export interface MenuOption {
  readonly value: string;
  readonly label: string;
  readonly checked: boolean;
}

export interface MenuGroup {
  readonly id: string;
  readonly label: string;
  readonly options: readonly MenuOption[];
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

const qualityLabel = (s: Readonly<UiState>, id: string | null): string | undefined => {
  const t = s.tracks.video.find((v) => v.id === id);
  if (t === undefined) return undefined;
  return t.height !== undefined ? `${t.height}p` : t.label ?? (t.bitrate === undefined ? t.id : formatBitrate(t.bitrate));
};

const trackLabel = (t: { readonly label?: string; readonly language?: string; readonly id: string }): string => t.label ?? t.language ?? t.id;

/** Groups of the settings menu from state: quality (when selectable), speed, captions. */
export function settingsGroups(s: Readonly<UiState>, strings: UiStrings): MenuGroup[] {
  const groups: MenuGroup[] = [];
  if (s.tracks.quality === 'selectable' && s.tracks.video.length > 1) {
    const active = qualityLabel(s, s.activeQuality);
    const auto = s.quality === 'auto' && active !== undefined ? fill(strings.qualityAutoActive, { label: active }) : strings.qualityAuto;
    groups.push({
      id: 'quality',
      label: strings.quality,
      options: [
        { value: 'auto', label: auto, checked: s.quality === 'auto' },
        ...[...s.tracks.video]
          .sort((a, b) => (b.height ?? b.bitrate ?? 0) - (a.height ?? a.bitrate ?? 0))
          .map((v) => ({ value: v.id, label: qualityLabel(s, v.id) ?? v.id, checked: s.quality === v.id })),
      ],
    });
  }
  groups.push({
    id: 'speed',
    label: strings.speed,
    options: PLAYBACK_RATES.map((r) => ({ value: String(r), label: r === 1 ? strings.speedNormal : `${r}x`, checked: s.playbackRate === r })),
  });
  if (s.tracks.audio.length > 1) {
    groups.push({
      id: 'audio',
      label: strings.audio,
      options: s.tracks.audio.map((a) => ({ value: a.id, label: trackLabel(a), checked: a.selected })),
    });
  }
  const tracks = s.textTracks ?? [];
  if (tracks.length > 0) {
    groups.push({
      id: 'captions',
      label: strings.captions,
      options: [
        { value: '', label: strings.captionsOff, checked: (s.textTrack ?? null) === null },
        ...tracks.map((t) => ({ value: t.id, label: trackLabel(t), checked: s.textTrack === t.id })),
      ],
    });
    groups.push(...captionStyleGroups(s, strings));
  }
  return groups;
}

/** CVAA caption display settings (47 CFR §79.103(c)); `value` is the JSON style patch. */
export function captionStyleGroups(s: Readonly<UiState>, strings: UiStrings): MenuGroup[] {
  const style: CaptionStyle = s.captionStyle ?? {};
  const group = <K extends keyof CaptionStyle>(id: string, label: string, key: K, values: readonly [CaptionStyle[K] | null, string][]): MenuGroup => ({
    id,
    label,
    options: values.map(([v, text]) => ({ value: JSON.stringify({ [key]: v }), label: text, checked: (style[key] ?? null) === v })),
  });
  return [
    group('caption-size', strings.captionSize, 'scale', [[null, strings.styleDefault], [0.75, '75%'], [1.5, '150%'], [2, '200%']]),
    group('caption-color', strings.captionColor, 'color', [[null, strings.styleDefault], ['#ffffff', strings.colorWhite], ['#ffff00', strings.colorYellow], ['#00ffff', strings.colorCyan], ['#00ff00', strings.colorGreen]]),
    group('caption-background', strings.captionBackground, 'backgroundOpacity', [[null, strings.styleDefault], [0, strings.backgroundNone], [0.5, strings.backgroundSemi], [1, strings.backgroundOpaque]]),
    group('caption-edge', strings.captionEdge, 'edge', [[null, strings.styleDefault], ['none', strings.edgeNone], ['shadow', strings.edgeShadow], ['outline', strings.edgeOutline], ['raised', strings.edgeRaised], ['depressed', strings.edgeDepressed]]),
    group('caption-font', strings.captionFont, 'font', [[null, strings.styleDefault], ['serif', strings.fontSerif], ['monospace', strings.fontMonospace], ['casual', strings.fontCasual]]),
  ];
}

let menuIds = 0;

/** Defines every element once per registry. Returns the constructors by tag name. */
export function defineOtterElements(options: DefineOptions = {}): Record<string, CustomElementConstructor> {
  const registry = options.registry ?? customElements;
  const Base = createBase();

  /** A button primitive: icon + accessible name from state; click dispatches. */
  abstract class ButtonElement extends Base {
    protected button: HTMLButtonElement | undefined;
    #icon = '';
    protected setup(): void {
      if (this.button !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${BUTTON_CSS}</style><button part="button" type="button"></button>`;
      this.button = root.querySelector('button') as HTMLButtonElement;
      this.button.addEventListener('click', (e) => this.activate(e));
    }
    protected abstract activate(e: Event): void;
    /** Updates label and icon only when they change (no DOM churn on every state tick). */
    protected show(label: string, icon: string): void {
      const b = this.button;
      if (b === undefined) return;
      if (b.getAttribute('aria-label') !== label) {
        b.setAttribute('aria-label', label);
        b.title = label;
      }
      if (this.#icon !== icon) {
        this.#icon = icon;
        b.innerHTML = svg(icon);
      }
    }
  }

  class PlayButton extends ButtonElement {
    protected activate(e: Event): void {
      this.ui?.dispatch('toggle-paused', {}, { type: e.type, source: 'otter-play-button' });
    }
    protected render(s: Readonly<UiState>): void {
      const playing = !s.paused;
      this.show(playing ? this.strings.pause : this.strings.play, playing ? ICON.pause : ICON.play);
      if (this.button !== undefined) this.button.disabled = s.status !== 'ready';
      this.toggleAttribute('paused', !playing);
    }
  }

  class MuteButton extends ButtonElement {
    protected activate(e: Event): void {
      this.ui?.dispatch('toggle-muted', {}, { type: e.type, source: 'otter-mute-button' });
    }
    protected render(s: Readonly<UiState>): void {
      const muted = s.muted || s.volume === 0;
      this.show(muted ? this.strings.unmute : this.strings.mute, muted ? ICON.muted : s.volume < 0.5 ? ICON.volumeLow : ICON.volume);
      this.toggleAttribute('muted', muted);
    }
  }

  class CaptionsButton extends ButtonElement {
    protected activate(e: Event): void {
      this.ui?.dispatch('toggle-captions', {}, { type: e.type, source: 'otter-captions-button' });
    }
    protected render(s: Readonly<UiState>): void {
      this.show(this.strings.captions, ICON.captions);
      unsupported(this, (s.textTracks ?? []).length === 0);
      this.button?.setAttribute('aria-pressed', String((s.textTrack ?? null) !== null));
    }
  }

  class FullscreenButton extends ButtonElement {
    protected activate(e: Event): void {
      this.ui?.dispatch('toggle-fullscreen', {}, { type: e.type, source: 'otter-fullscreen-button' });
    }
    protected render(s: Readonly<UiState>): void {
      const on = s.fullscreen === true;
      this.show(on ? this.strings.exitFullscreen : this.strings.fullscreen, on ? ICON.exitFullscreen : ICON.fullscreen);
      unsupported(this, s.fullscreenAvailable === false);
    }
  }

  class PipButton extends ButtonElement {
    protected activate(e: Event): void {
      this.ui?.dispatch('toggle-pip', {}, { type: e.type, source: 'otter-pip-button' });
    }
    protected render(s: Readonly<UiState>): void {
      const on = s.pip === true;
      this.show(on ? this.strings.exitPip : this.strings.pip, ICON.pip);
      this.button?.setAttribute('aria-pressed', String(on));
      unsupported(this, s.pipAvailable !== true);
    }
  }

  class TimeDisplay extends Base {
    #text: HTMLElement | undefined;
    protected setup(): void {
      if (this.#text !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>:host([hidden]){display:none}:host{display:inline-flex;align-items:center;color:var(--otter-fg,#fff);font:var(--otter-font-mono,500 13px/1 ui-monospace,monospace);font-variant-numeric:tabular-nums;white-space:nowrap}</style><span part="text"></span>`;
      this.#text = root.querySelector('span') as HTMLElement;
    }
    protected render(s: Readonly<UiState>): void {
      const t = this.#text;
      if (t === undefined) return;
      // Visual "1:15 / 1:30"; the slider carries the spoken form.
      const text = s.live ? this.strings.live : `${formatTime(s.currentTime)} / ${formatTime(s.duration)}`;
      if (t.textContent !== text) t.textContent = text;
    }
  }

  class TimeSlider extends Base {
    #input: HTMLInputElement | undefined;
    #dragging = false;
    protected setup(): void {
      if (this.#input !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${SLIDER_CSS}
:host { position: relative; }
.preview { position: absolute; bottom: 100%; transform: translateX(-50%); padding: 2px 6px; border-radius: 4px;
  background: var(--otter-bg-deep, #1e2d40); color: var(--otter-fg, #fff); font: var(--otter-font-mono, 500 12px/1.4 ui-monospace, monospace); pointer-events: none; }
.preview[hidden] { display: none; }
</style><input part="range" type="range" min="0" max="0" step="0.1" value="0"><span class="preview" part="preview" aria-hidden="true" hidden></span>`;
      const input = root.querySelector('input') as HTMLInputElement;
      this.#input = input;
      input.addEventListener('input', () => {
        this.#dragging = true;
        this.#valueText(Number(input.value), Number(input.max));
      });
      input.addEventListener('change', (e) => {
        this.#dragging = false;
        this.ui?.dispatch('seek', { time: Number(input.value) }, { type: e.type, source: 'otter-time-slider' });
      });
    }
    #valueText(current: number, duration: number): void {
      this.#input?.setAttribute('aria-valuetext', fill(this.strings.timeOf, { current: speakTime(current), duration: speakTime(duration) }));
    }
    protected render(s: Readonly<UiState>): void {
      const input = this.#input;
      if (input === undefined) return;
      if (input.getAttribute('aria-label') !== this.strings.seek) input.setAttribute('aria-label', this.strings.seek);
      const seekable = Number.isFinite(s.duration) && s.duration > 0 && !s.live;
      input.disabled = !seekable;
      const preview = this.shadowRoot?.querySelector<HTMLElement>('.preview');
      if (!seekable) {
        if (preview !== undefined && preview !== null) preview.hidden = true;
        return;
      }
      if (input.max !== String(s.duration)) input.max = String(s.duration);
      if (!this.#dragging) {
        input.value = String(s.currentTime);
        this.#valueText(s.currentTime, s.duration);
      }
      this.style.setProperty('--otter-buffered', `${Math.min(100, (s.bufferedEnd / s.duration) * 100)}%`);
      // Swipe seek preview (chrome slice): where the release would land.
      if (preview !== null && preview !== undefined) {
        const offset = s.seekPreview ?? null;
        preview.hidden = offset === null;
        if (offset !== null) {
          const target = Math.min(s.duration, Math.max(0, s.currentTime + offset));
          preview.textContent = `${offset >= 0 ? '+' : '−'}${formatTime(Math.abs(offset))} · ${formatTime(target)}`;
          preview.style.left = `${(target / s.duration) * 100}%`;
        }
      }
    }
  }

  class VolumeSlider extends Base {
    #input: HTMLInputElement | undefined;
    protected setup(): void {
      if (this.#input !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${SLIDER_CSS} :host { flex: 0 1 96px; min-width: 64px; }</style><input part="range" type="range" min="0" max="1" step="0.05" value="1">`;
      const input = root.querySelector('input') as HTMLInputElement;
      this.#input = input;
      input.addEventListener('input', (e) => {
        const volume = Number(input.value);
        const trigger = { type: e.type, source: 'otter-volume-slider' };
        this.ui?.dispatch('set-volume', { volume }, trigger);
        // Raising the volume of a muted player unmutes it (and 0 reads as muted anyway).
        if (volume > 0 && this.ui?.getState().muted === true) this.ui.dispatch('set-muted', { muted: false }, trigger);
      });
    }
    protected render(s: Readonly<UiState>): void {
      const input = this.#input;
      if (input === undefined) return;
      if (input.getAttribute('aria-label') !== this.strings.volume) input.setAttribute('aria-label', this.strings.volume);
      const value = s.muted ? 0 : s.volume;
      if (Number(input.value) !== value) input.value = String(value);
      input.setAttribute('aria-valuetext', s.muted ? this.strings.announceMuted : speakVolume(s.volume));
    }
  }

  class LiveIndicator extends Base {
    #badge: HTMLElement | undefined;
    protected setup(): void {
      if (this.#badge !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
:host { display: inline-flex; align-items: center; }
:host([hidden]), :host([data-otter-unsupported]) { display: none; }
span { display: inline-flex; align-items: center; gap: 6px; font: var(--otter-font, 700 12px/1 system-ui, sans-serif);
  text-transform: uppercase; letter-spacing: 0.04em; color: var(--otter-fg, #fff); }
span::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--otter-live, #ff4e45); }
:host([behind]) span::before { background: var(--otter-live-behind, #8a96a3); }
</style><span part="badge" role="status"></span>`;
      this.#badge = root.querySelector('span') as HTMLElement;
    }
    protected render(s: Readonly<UiState>): void {
      const badge = this.#badge;
      if (badge === undefined) return;
      unsupported(this, !s.live);
      // Behind the live edge by more than ~3 target durations of a typical HLS live window.
      const behind = s.live && s.latency !== null && s.latency > 10;
      this.toggleAttribute('behind', behind);
      const text = behind ? this.strings.behindLive : this.strings.live;
      if (badge.textContent !== text) badge.textContent = text;
    }
  }

  /** Visual tooltip for the element named by `for` (by id, in the same tree); the name stays aria-label. */
  class Tooltip extends Base {
    #tip: HTMLElement | undefined;
    #target: Element | null = null;
    #show = (): void => {
      if (this.#tip === undefined) return;
      const label = this.#target?.shadowRoot?.querySelector('[aria-label]')?.getAttribute('aria-label') ?? this.#target?.getAttribute('aria-label') ?? this.textContent ?? '';
      this.#tip.textContent = label;
      this.hidden = label === '';
    };
    #hide = (): void => {
      this.hidden = true;
    };
    protected setup(): void {
      if (this.#tip !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>:host { position: absolute; z-index: 10; pointer-events: none; }
:host([hidden]) { display: none; }
span { display: block; padding: 4px 8px; border-radius: 4px; white-space: nowrap; background: var(--otter-bg-deep, #1e2d40);
  color: var(--otter-fg, #fff); font: var(--otter-font, 500 12px/1.3 system-ui, sans-serif); }</style><span part="tooltip" role="tooltip"></span>`;
      this.#tip = root.querySelector('span') as HTMLElement;
      this.hidden = true;
      const id = this.getAttribute('for');
      this.#target = id === null ? this.previousElementSibling : (this.getRootNode() as Document | ShadowRoot).getElementById?.(id) ?? null;
      for (const [e, h] of [['pointerenter', this.#show], ['focusin', this.#show], ['pointerleave', this.#hide], ['focusout', this.#hide]] as const) {
        this.#target?.addEventListener(e, h);
      }
    }
    protected render(): void {
      // Text follows the target's current label when shown.
    }
  }

  /** Gesture surface over the picture: the dimming layer and gesture feedback. */
  class Gesture extends Base {
    #dim: HTMLElement | undefined;
    protected setup(): void {
      if (this.#dim !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>:host { position: absolute; inset: 0; display: block; }
.dim { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; transition: opacity 0.15s; }
@media (prefers-reduced-motion: reduce) { .dim { transition: none; } }</style><div class="dim" part="dim"></div><slot></slot>`;
      this.#dim = root.querySelector('.dim') as HTMLElement;
    }
    protected render(s: Readonly<UiState>): void {
      const dim = this.#dim;
      if (dim === undefined) return;
      const opacity = String(Math.max(0, Math.min(0.8, 1 - (s.brightness ?? 1))));
      if (dim.style.opacity !== opacity) dim.style.opacity = opacity;
    }
  }

  class Poster extends Base {
    #img: HTMLImageElement | undefined;
    static get observedAttributes(): string[] {
      return ['src'];
    }
    attributeChangedCallback(): void {
      if (this.#img !== undefined) this.#img.src = this.getAttribute('src') ?? '';
    }
    protected setup(): void {
      if (this.#img !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>:host { position: absolute; inset: 0; display: block; pointer-events: none; }
:host([hidden]) { display: none; } img { width: 100%; height: 100%; object-fit: var(--otter-poster-fit, contain); }</style><img part="img" alt="">`;
      this.#img = root.querySelector('img') as HTMLImageElement;
      this.#img.src = this.getAttribute('src') ?? '';
      // Decorative: the player region is labelled; the picture itself has no text alternative.
      this.setAttribute('aria-hidden', 'true');
    }
    protected render(s: Readonly<UiState>): void {
      const started = s.qoe?.ttff != null || (!s.paused && s.readyState >= 2) || s.currentTime > 0;
      this.hidden = this.getAttribute('src') === null || started;
    }
  }

  class Spinner extends Base {
    #el: HTMLElement | undefined;
    protected setup(): void {
      if (this.#el !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>:host { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
:host([hidden]) { display: none; }
div { width: 48px; height: 48px; border-radius: 50%; border: 4px solid color-mix(in srgb, var(--otter-fg, #fff) 25%, transparent);
  border-top-color: var(--otter-accent, #1ee9e6); animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { div { animation-duration: 3s; } }</style><div part="spinner" role="progressbar"></div>`;
      this.#el = root.querySelector('div') as HTMLElement;
    }
    protected render(s: Readonly<UiState>): void {
      const busy = s.status === 'loading' || (s.waiting && !s.paused && s.status === 'ready');
      this.hidden = !busy;
      this.#el?.setAttribute('aria-label', this.strings.loading);
    }
  }

  /** aria-live region: announces state changes the user caused or needs to know about. */
  class Announcer extends Base {
    #region: HTMLElement | undefined;
    #prev: Readonly<UiState> | undefined;
    #volumeTimer: ReturnType<typeof setTimeout> | undefined;
    protected setup(): void {
      if (this.#region !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>:host { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }</style><div part="region" role="status" aria-live="polite" aria-atomic="true"></div>`;
      this.#region = root.querySelector('div') as HTMLElement;
    }
    say(message: string): void {
      const r = this.#region;
      if (r === undefined) return;
      // Re-announce identical text: clear first, set on the next frame.
      r.textContent = '';
      setTimeout(() => {
        r.textContent = message;
      }, 50);
    }
    protected render(s: Readonly<UiState>): void {
      const p = this.#prev;
      this.#prev = s;
      if (p === undefined) return;
      const t = this.strings;
      if (s.status === 'ready' && p.status === 'ready' && s.paused !== p.paused && !s.ended) this.say(s.paused ? t.announcePaused : t.announcePlaying);
      if (s.muted !== p.muted) this.say(s.muted ? t.announceMuted : t.announceUnmuted);
      if (s.volume !== p.volume && !s.muted) {
        // Slider drags and key repeats: announce where it settled.
        if (this.#volumeTimer !== undefined) clearTimeout(this.#volumeTimer);
        this.#volumeTimer = setTimeout(() => this.say(fill(t.announceVolume, { n: Math.round(s.volume * 100) })), 400);
      }
      if ((s.textTrack ?? null) !== (p.textTrack ?? null)) {
        const track = s.textTracks?.find((x) => x.id === s.textTrack);
        this.say(track === undefined ? t.announceCaptionsOff : fill(t.announceCaptionsOn, { label: trackLabel(track) }));
      }
      if (s.quality !== p.quality) this.say(fill(t.announceQuality, { label: s.quality === 'auto' ? t.qualityAuto : qualityLabel(s, s.quality) ?? s.quality }));
      if (s.playbackRate !== p.playbackRate) this.say(fill(t.announceSpeed, { n: s.playbackRate }));
      if (s.fullscreen !== p.fullscreen && s.fullscreen !== undefined) this.say(s.fullscreen ? t.announceFullscreen : t.announceExitFullscreen);
      if (s.error !== null && s.error !== p.error && s.error.fatal) this.say(fill(t.announceError, { label: s.error.details }));
    }
  }

  /** menuitemradio inside an otter-menu. `value`, `checked` and the text content are the API. */
  class MenuItem extends HTMLElement {
    static get observedAttributes(): string[] {
      return ['checked'];
    }
    connectedCallback(): void {
      this.setAttribute('role', 'menuitemradio');
      this.tabIndex = -1;
      this.attributeChangedCallback();
    }
    attributeChangedCallback(): void {
      this.setAttribute('aria-checked', String(this.hasAttribute('checked')));
    }
  }

  /**
   * Menu button + menu (WAI-ARIA APG menu button pattern): Enter / Space / ArrowDown open and
   * focus the checked item, arrows / Home / End move, Enter / Space choose, Esc and Tab close and
   * return focus to the trigger. Fires `otter-select` with { group, value }.
   */
  class Menu extends Base {
    protected trigger: HTMLButtonElement | undefined;
    protected list: HTMLElement | undefined;
    readonly menuId = `otter-menu-${++menuIds}`;
    protected setup(): void {
      if (this.trigger !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${BUTTON_CSS}
:host { position: relative; }
[role="menu"] { position: absolute; bottom: calc(100% + 4px); right: 0; min-width: 180px; max-height: var(--otter-menu-max-height, 60vh); overflow: auto;
  padding: 4px; border-radius: var(--otter-radius, 8px); background: color-mix(in srgb, var(--otter-bg-deep, #1e2d40) 96%, transparent);
  color: var(--otter-fg, #fff); font: var(--otter-font, 500 14px/1.2 system-ui, sans-serif); box-shadow: 0 4px 16px rgb(0 0 0 / 0.4); }
[role="menu"][hidden] { display: none; }
[role="group"] > [role="presentation"] { padding: 8px 12px 4px; font-size: 12px; opacity: 0.75; }
::slotted(otter-menu-item), [role="menuitemradio"] { display: flex; align-items: center; gap: 8px; min-height: var(--otter-control-size, 44px);
  padding: 0 12px; border-radius: 6px; cursor: pointer; }
[role="menuitemradio"]::before { content: ''; width: 16px; text-align: center; }
[role="menuitemradio"][aria-checked="true"]::before { content: '✓'; color: var(--otter-accent, #1ee9e6); }
[role="menuitemradio"]:hover { background: color-mix(in srgb, var(--otter-fg, #fff) 10%, transparent); }
[role="menuitemradio"]:focus-visible { outline: 3px solid var(--otter-accent, #1ee9e6); outline-offset: -3px; }
</style><button part="button trigger" type="button" aria-haspopup="menu" aria-expanded="false"></button><div part="menu" role="menu" hidden><slot></slot></div>`;
      const trigger = root.querySelector('button') as HTMLButtonElement;
      const list = root.querySelector('[role="menu"]') as HTMLElement;
      this.trigger = trigger;
      this.list = list;
      list.id = this.menuId;
      trigger.setAttribute('aria-controls', this.menuId);
      trigger.addEventListener('click', () => (this.open ? this.close(true) : this.openMenu('checked')));
      trigger.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          this.openMenu(e.key === 'ArrowUp' ? 'last' : 'checked');
        }
      });
      list.addEventListener('keydown', (e) => this.#onKey(e));
      list.addEventListener('click', (e) => {
        const item = this.#itemFrom(e);
        if (item !== undefined) this.choose(item);
      });
      // Clicking elsewhere closes the menu.
      this.ownerDocument.addEventListener('pointerdown', (e) => {
        if (this.open && !e.composedPath().includes(this)) this.close(false);
      });
    }
    get open(): boolean {
      return this.list !== undefined && !this.list.hidden;
    }
    protected items(): HTMLElement[] {
      const slot = this.list?.querySelector('slot');
      const slotted = (slot?.assignedElements() ?? []).filter((e): e is HTMLElement => e.getAttribute('role') === 'menuitemradio');
      const own = [...(this.list?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
      return [...own, ...slotted];
    }
    #itemFrom(e: Event): HTMLElement | undefined {
      for (const n of e.composedPath()) {
        if (n === this.list) return undefined;
        if (n instanceof HTMLElement && n.getAttribute('role') === 'menuitemradio') return n;
      }
      return undefined;
    }
    openMenu(focus: 'checked' | 'first' | 'last'): void {
      const list = this.list;
      if (list === undefined) return;
      this.beforeOpen();
      list.hidden = false;
      this.trigger?.setAttribute('aria-expanded', 'true');
      this.ui?.dispatch('open-menu', { id: this.menuId });
      const items = this.items();
      const target = focus === 'last' ? items.at(-1) : focus === 'first' ? items[0] : (items.find((i) => i.getAttribute('aria-checked') === 'true') ?? items[0]);
      if (target !== undefined) this.focusItem(target);
    }
    /** Roving tabindex (APG): the focused item is the menu's only tab stop. */
    protected focusItem(item: HTMLElement): void {
      for (const i of this.items()) i.tabIndex = i === item ? 0 : -1;
      item.focus();
    }
    close(returnFocus: boolean): void {
      if (this.list === undefined || this.list.hidden) return;
      this.list.hidden = true;
      this.trigger?.setAttribute('aria-expanded', 'false');
      if (this.ui?.getState().menu === this.menuId) this.ui.dispatch('open-menu', { id: null });
      if (returnFocus) this.trigger?.focus();
    }
    protected choose(item: HTMLElement): void {
      this.dispatchEvent(
        new CustomEvent('otter-select', {
          bubbles: true,
          composed: true,
          detail: { group: item.dataset['group'] ?? item.closest('[data-group]')?.getAttribute('data-group') ?? '', value: item.getAttribute('value') ?? item.dataset['value'] ?? '' },
        }),
      );
      this.close(true);
    }
    #onKey(e: KeyboardEvent): void {
      const items = this.items();
      const shadow = this.shadowRoot;
      const current = (shadow?.activeElement as HTMLElement | null) ?? (this.ownerDocument.activeElement as HTMLElement | null);
      const index = items.findIndex((i) => i === current);
      const move = (to: number): void => {
        e.preventDefault();
        const item = items[(to + items.length) % items.length];
        if (item !== undefined) this.focusItem(item);
      };
      switch (e.key) {
        case 'ArrowDown':
          move(index + 1);
          break;
        case 'ArrowUp':
          move(index - 1);
          break;
        case 'Home':
          move(0);
          break;
        case 'End':
          move(items.length - 1);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (index >= 0) this.choose(items[index] as HTMLElement);
          break;
        case 'Escape':
          // Handled here: the player's Esc (leave fullscreen) must not fire as well.
          e.preventDefault();
          e.stopPropagation();
          this.close(true);
          break;
        case 'Tab':
          this.close(false);
          break;
        default:
          break;
      }
    }
    /** Composites rebuild their items here. */
    protected beforeOpen(): void {}
    protected render(s: Readonly<UiState>): void {
      this.label();
      // Another menu opened, or Esc went through the chrome plugin.
      if (this.open && s.menu !== undefined && s.menu !== this.menuId) this.close(false);
    }
    protected label(): void {
      if (this.trigger === undefined) return;
      const label = this.getAttribute('label') ?? '';
      if (this.trigger.getAttribute('aria-label') !== label) {
        this.trigger.setAttribute('aria-label', label);
        this.trigger.title = label;
        this.trigger.innerHTML = svg(ICON.settings);
      }
    }
  }

  /** Settings: quality (shows the actual rendition under Auto), speed, captions. */
  class SettingsMenu extends Menu {
    #groups: MenuGroup[] = [];
    #signature = '';
    constructor() {
      super();
      this.addEventListener('otter-select', (e) => {
        const { group, value } = (e as CustomEvent<{ group: string; value: string }>).detail;
        const trigger = { type: 'click', source: 'otter-settings-menu' };
        if (group === 'quality') this.ui?.dispatch('select-quality', { id: value }, trigger);
        else if (group === 'speed') this.ui?.dispatch('set-playback-rate', { rate: Number(value) }, trigger);
        else if (group === 'captions') this.ui?.dispatch('select-text-track', { id: value === '' ? null : value }, trigger);
        else if (group === 'audio') this.ui?.dispatch('select-audio-track', { id: value }, trigger);
        else if (group.startsWith('caption-')) this.ui?.dispatch('set-caption-style', JSON.parse(value) as Record<string, never>, trigger);
      });
    }
    protected override label(): void {
      if (this.trigger === undefined) return;
      const label = this.strings.settings;
      if (this.trigger.getAttribute('aria-label') !== label) {
        this.trigger.setAttribute('aria-label', label);
        this.trigger.title = label;
        this.trigger.innerHTML = svg(ICON.settings);
      }
    }
    protected override beforeOpen(): void {
      const s = this.ui?.getState();
      if (s !== undefined) this.#build(s);
    }
    #build(s: Readonly<UiState>): void {
      const list = this.list;
      if (list === undefined) return;
      this.#groups = settingsGroups(s, this.strings);
      const signature = JSON.stringify(this.#groups);
      if (signature === this.#signature) return;
      this.#signature = signature;
      const focusedValue = (this.shadowRoot?.activeElement as HTMLElement | null)?.dataset['key'];
      const doc = this.ownerDocument;
      const nodes = this.#groups.map((g) => {
        const group = doc.createElement('div');
        group.setAttribute('role', 'group');
        group.dataset['group'] = g.id;
        const heading = doc.createElement('div');
        heading.setAttribute('role', 'presentation');
        heading.id = `${this.menuId}-${g.id}`;
        heading.textContent = g.label;
        group.setAttribute('aria-labelledby', heading.id);
        group.append(heading);
        for (const o of g.options) {
          const item = doc.createElement('div');
          item.setAttribute('role', 'menuitemradio');
          item.setAttribute('aria-checked', String(o.checked));
          item.setAttribute('value', o.value);
          item.dataset['group'] = g.id;
          item.dataset['key'] = `${g.id}:${o.value}`;
          item.tabIndex = -1;
          item.textContent = o.label;
          group.append(item);
        }
        return group;
      });
      const slot = list.querySelector('slot');
      list.replaceChildren(...nodes, ...(slot === null ? [] : [slot]));
      const refocus = focusedValue === undefined ? null : list.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusedValue)}"]`);
      if (refocus !== null && this.open) this.focusItem(refocus);
    }
    protected override render(s: Readonly<UiState>): void {
      super.render(s);
      // Keep an open menu current (e.g. "Auto (720p)" while ABR switches).
      if (this.open) this.#build(s);
    }
  }

  class Stats extends Base {
    #list: HTMLElement | undefined;
    #route: HTMLElement | undefined;
    protected setup(): void {
      if (this.#list !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
:host([hidden]) { display: none; }
:host { display: block; color: var(--otter-fg, #fff); background: color-mix(in srgb, var(--otter-bg, #243447) 88%, transparent);
  font: var(--otter-font-mono, 12px/1.5 ui-monospace, monospace); padding: 8px 12px; border-radius: var(--otter-radius, 8px); max-width: 100%; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0 12px; margin: 0; }
dt { opacity: 0.75; } dd { margin: 0; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; margin: 4px 0 0; max-height: 12em; overflow: auto; }
summary { cursor: pointer; } summary:focus-visible { outline: 3px solid var(--otter-accent, #1ee9e6); }
</style><section part="panel"><dl part="list"></dl>
<details part="route"><summary>Route (router.explain)</summary><pre></pre></details></section>`;
      this.#list = root.querySelector('dl') as HTMLElement;
      this.#route = root.querySelector('pre') as HTMLElement;
    }
    protected render(s: Readonly<UiState>): void {
      const list = this.#list;
      const route = this.#route;
      if (list === undefined || route === undefined) return;
      this.shadowRoot?.querySelector('section')?.setAttribute('aria-label', this.strings.statistics);
      const q = s.qoe;
      const active = s.tracks.video.find((v) => v.id === s.activeQuality) ?? s.tracks.video.find((v) => v.selected);
      const buffer = Math.max(0, s.bufferedEnd - s.currentTime);
      const rows: [string, string][] = [
        ['Status', s.error === null ? s.status : `${s.status} (${s.error.type}: ${s.error.details})`],
        ['Format / backend', `${s.format ?? '–'} / ${s.backend ?? '–'}${s.mms ? ' (ManagedMediaSource)' : ''}`],
        ['Remote playback', s.remotePlayback ?? '–'],
        ['Resolution', s.videoWidth > 0 ? `${s.videoWidth}×${s.videoHeight}` : '–'],
        ['Quality', `${s.activeQuality ?? '–'} (${s.quality})${active?.bitrate === undefined ? '' : ` · ${formatBitrate(active.bitrate)}`}`],
        ['Codec', active?.codec ?? q?.codec ?? '–'],
        ['Buffer', formatSeconds(buffer)],
        ['Bandwidth', formatBitrate(q?.bandwidth)],
        ['Latency', s.live ? formatSeconds(s.latency ?? q?.latency) : '–'],
        ['Dropped frames', q === undefined ? '–' : `${q.droppedFrames} / ${q.totalFrames}`],
        ['TTFF', formatMs(q?.ttff)],
        ['Rebuffers', q === undefined ? '–' : `${q.rebufferCount} (${formatMs(q.rebufferDuration)})`],
        ['Quality switches', q === undefined ? '–' : String(q.qualitySwitches)],
        ['Errors', q === undefined ? '–' : `${q.errors}${q.lastError === null ? '' : ` (last: ${q.lastError.details})`}`],
      ];
      const html = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd data-stat="${escapeHtml(k)}">${escapeHtml(v)}</dd>`).join('');
      if (list.innerHTML !== html) list.innerHTML = html;
      const json = s.route === null ? 'no decision yet' : JSON.stringify(s.route, null, 2);
      if (route.textContent !== json) route.textContent = json;
    }
  }

  const classes: Record<string, CustomElementConstructor> = {
    [M1_ELEMENTS.PlayButton]: PlayButton,
    [M1_ELEMENTS.MuteButton]: MuteButton,
    [M1_ELEMENTS.TimeDisplay]: TimeDisplay,
    [M1_ELEMENTS.TimeSlider]: TimeSlider,
    [M1_ELEMENTS.Stats]: Stats,
    [M2_ELEMENTS.VolumeSlider]: VolumeSlider,
    [M2_ELEMENTS.LiveIndicator]: LiveIndicator,
    [M2_ELEMENTS.Menu]: Menu,
    [M2_ELEMENTS.MenuItem]: MenuItem,
    [M2_ELEMENTS.Tooltip]: Tooltip,
    [M2_ELEMENTS.Gesture]: Gesture,
    [M2_ELEMENTS.Poster]: Poster,
    [M2_ELEMENTS.Spinner]: Spinner,
    [M2_ELEMENTS.Announcer]: Announcer,
    [M2_ELEMENTS.CaptionsButton]: CaptionsButton,
    [M2_ELEMENTS.FullscreenButton]: FullscreenButton,
    [M2_ELEMENTS.PipButton]: PipButton,
    [M2_ELEMENTS.SettingsMenu]: SettingsMenu,
  };
  const defined: Record<string, CustomElementConstructor> = {};
  for (const [tag, ctor] of Object.entries(classes)) {
    const existing = registry.get(tag);
    if (existing === undefined) registry.define(tag, ctor);
    defined[tag] = existing ?? ctor;
  }
  return defined;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
