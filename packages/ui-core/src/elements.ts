// UI primitives and composites (SPEC §14.1 / §14.2, ADR-005 §6, UI-DESIGN v1). Every control is
// a native <button> / <input type=range> or a complete ARIA pattern (menu with menuitem /
// menuitemradio / menuitemcheckbox), has a visible focus ring and takes its text from the
// strings table. Clicks dispatch synchronously, so play, fullscreen and PiP keep their user
// activation (SPEC §3 rule 3). Icons are Lucide (ADR-006), one SVG per state, cross-faded.
//
// Element classes are built on first use by module-level factories (no `extends HTMLElement` at
// top level: Workers / SSR, AGENT §4), so a bundler keeps only the elements a host defines.

import {
  Airplay,
  AudioLines,
  Captions,
  CaptionsOff,
  Cast,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Settings2,
  Type,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide';
import type { Thumbnail } from '@otter-player/media';
import { findThumbnails, type UiActions, type UiState } from './context.js';
import { formatBitrate, formatMs, formatSeconds, formatTime } from './format.js';
import { icon, LiveDot, SpinnerRing, Theater, type IconNode } from './icons.js';
import { buttonCss, createBase, glass, glassFallback, rangeCss, REDUCED_MOTION, speakTime, speakVolume, T, unsupported, type OtterBase } from './primitives.js';
import { fill, type UiStrings } from './strings.js';

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

/** M2.5 visual layer (UI-DESIGN §6). */
export const M25_ELEMENTS = {
  QualityMenu: 'otter-quality-menu',
  SpeedMenu: 'otter-speed-menu',
  SeekButton: 'otter-seek-button',
  BigPlay: 'otter-big-play',
  Feedback: 'otter-feedback',
  ErrorCard: 'otter-error',
} as const;

/** M3 presentation controls (ADR-007 §5). */
export const M3_ELEMENTS = {
  TheaterButton: 'otter-theater-button',
  CastButton: 'otter-cast-button',
  AirPlayButton: 'otter-airplay-button',
  MiniClose: 'otter-mini-close',
} as const;

export interface DefineOptions {
  readonly registry?: CustomElementRegistry;
}

/** One selectable entry of a menu group. */
export interface MenuOption {
  readonly value: string;
  readonly label: string;
  /** Second line (quality: "2.5 Mbps"). */
  readonly detail?: string;
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
  return t.height !== undefined ? `${t.height}P` : t.label ?? (t.bitrate === undefined ? t.id : formatBitrate(t.bitrate));
};

const trackLabel = (t: { readonly label?: string; readonly language?: string; readonly id: string }): string => t.label ?? t.language ?? t.id;

const rateLabel = (r: number): string => `${r.toFixed(r * 100 % 10 === 0 ? 1 : 2)}x`;

/**
 * Level-one groups of the settings menu from state: quality (when selectable), speed, audio,
 * captions. The caption style groups come with the level-two views (settings-level.ts).
 */
export function settingsGroups(s: Readonly<UiState>, strings: UiStrings): MenuGroup[] {
  const groups: MenuGroup[] = [];
  if (s.tracks.quality === 'selectable' && s.tracks.video.length > 1) groups.push(qualityGroup(s, strings));
  groups.push(speedGroup(s, strings));
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
  }
  return groups;
}

function qualityGroup(s: Readonly<UiState>, strings: UiStrings): MenuGroup {
  const active = qualityLabel(s, s.activeQuality);
  const auto = s.quality === 'auto' && active !== undefined ? fill(strings.qualityAutoActive, { label: active }) : strings.qualityAuto;
  return {
    id: 'quality',
    label: strings.quality,
    options: [
      { value: 'auto', label: auto, checked: s.quality === 'auto' },
      ...[...s.tracks.video]
        .sort((a, b) => (b.height ?? b.bitrate ?? 0) - (a.height ?? a.bitrate ?? 0))
        .map((v) => ({
          value: v.id,
          label: qualityLabel(s, v.id) ?? v.id,
          ...(v.bitrate === undefined ? {} : { detail: formatBitrate(v.bitrate) }),
          checked: s.quality === v.id,
        })),
    ],
  };
}

function speedGroup(s: Readonly<UiState>, strings: UiStrings): MenuGroup {
  return {
    id: 'speed',
    label: strings.speed,
    options: PLAYBACK_RATES.map((r) => ({ value: String(r), label: r === 1 ? strings.speedNormal : `${r}x`, checked: s.playbackRate === r })),
  };
}

let menuIds = 0;

type Ctor = CustomElementConstructor;
const built = new Map<string, unknown>();
const once = <T>(key: string, make: () => T): T => {
  if (!built.has(key)) built.set(key, make());
  return built.get(key) as T;
};
const base = (): OtterBase => once('base', createBase);

const playerRoot = (el: Element): Element | null => el.closest('[data-otter-player]');

/** Item by its data-key (values are JSON: no attribute selector, no escaping). */
const byKey = (root: ParentNode | undefined, key: string): HTMLElement | null =>
  [...(root?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find((e) => e.dataset['key'] === key) ?? null;

// ---- Buttons ---------------------------------------------------------------------------------

/** Icon button: every state's icon is rendered once and cross-faded (UI-DESIGN §5). */
const buttonElementClass = () =>
  once('ButtonElement', () => {
    const Base = base();
    abstract class ButtonElement extends Base {
      protected button: HTMLButtonElement | undefined;
      #tip: HTMLElement | undefined;
      #shown = '';
      /** State name -> icon. The first entry is shown before the first render. */
      protected abstract icons(): Readonly<Record<string, IconNode>>;
      protected setup(): void {
        if (this.button !== undefined) return;
        const root = this.attachShadow({ mode: 'open' });
        const svgs = Object.entries(this.icons())
          .map(([k, n], i) => icon(n).replace('<svg ', `<svg data-icon="${k}"${i === 0 ? ' data-on' : ''} `))
          .join('');
        root.innerHTML = `<style>${buttonCss()}${this.extraCss()}</style><button part="button" type="button"><span class="icon">${svgs}</span>${this.extraHtml()}</button><span class="tip" part="tooltip" aria-hidden="true"></span>`;
        this.button = root.querySelector('button') as HTMLButtonElement;
        this.#tip = root.querySelector('.tip') as HTMLElement;
        this.button.addEventListener('click', (e) => this.activate(e));
      }
      protected extraCss(): string {
        return '';
      }
      protected extraHtml(): string {
        return '';
      }
      protected abstract activate(e: Event): void;
      /** Accessible name + tooltip + visible icon; DOM is touched only when something changes. */
      protected show(label: string, state: string): void {
        const b = this.button;
        if (b === undefined) return;
        if (b.getAttribute('aria-label') !== label) {
          b.setAttribute('aria-label', label);
          if (this.#tip !== undefined) this.#tip.textContent = label;
        }
        if (this.#shown !== state) {
          this.#shown = state;
          for (const svg of b.querySelectorAll('svg[data-icon]')) svg.toggleAttribute('data-on', svg.getAttribute('data-icon') === state);
        }
      }
    }
    return ButtonElement;
  });

const playButtonClass = () =>
  once('PlayButton', () => {
    const ButtonElement = buttonElementClass();
    return class PlayButton extends ButtonElement {
      protected icons(): Record<string, IconNode> {
        return { play: Play, pause: Pause };
      }
      protected activate(e: Event): void {
        this.ui?.dispatch('toggle-paused', {}, { type: e.type, source: 'otter-play-button' });
      }
      protected render(s: Readonly<UiState>): void {
        const playing = !s.paused;
        this.show(playing ? this.strings.pause : this.strings.play, playing ? 'pause' : 'play');
        if (this.button !== undefined) this.button.disabled = s.status !== 'ready';
        this.toggleAttribute('paused', !playing);
      }
    };
  });

const muteButtonClass = () =>
  once('MuteButton', () => {
    const ButtonElement = buttonElementClass();
    return class MuteButton extends ButtonElement {
      protected icons(): Record<string, IconNode> {
        return { high: Volume2, low: Volume1, muted: VolumeX };
      }
      protected activate(e: Event): void {
        this.ui?.dispatch('toggle-muted', {}, { type: e.type, source: 'otter-mute-button' });
      }
      protected render(s: Readonly<UiState>): void {
        const muted = s.muted || s.volume === 0;
        this.show(muted ? this.strings.unmute : this.strings.mute, muted ? 'muted' : s.volume < 0.5 ? 'low' : 'high');
        this.toggleAttribute('muted', muted);
      }
    };
  });

const captionsButtonClass = () =>
  once('CaptionsButton', () => {
    const ButtonElement = buttonElementClass();
    return class CaptionsButton extends ButtonElement {
      protected icons(): Record<string, IconNode> {
        return { off: CaptionsOff, on: Captions };
      }
      protected activate(e: Event): void {
        this.ui?.dispatch('toggle-captions', {}, { type: e.type, source: 'otter-captions-button' });
      }
      protected render(s: Readonly<UiState>): void {
        const on = (s.textTrack ?? null) !== null;
        this.show(this.strings.captions, on ? 'on' : 'off');
        unsupported(this, (s.textTracks ?? []).length === 0);
        this.button?.setAttribute('aria-pressed', String(on));
      }
    };
  });

const fullscreenButtonClass = () =>
  once('FullscreenButton', () => {
    const ButtonElement = buttonElementClass();
    return class FullscreenButton extends ButtonElement {
      protected icons(): Record<string, IconNode> {
        return { enter: Maximize, exit: Minimize };
      }
      protected activate(e: Event): void {
        this.ui?.dispatch('toggle-fullscreen', {}, { type: e.type, source: 'otter-fullscreen-button' });
      }
      protected render(s: Readonly<UiState>): void {
        const on = s.presentation?.mode === 'fullscreen';
        this.show(on ? this.strings.exitFullscreen : this.strings.fullscreen, on ? 'exit' : 'enter');
        unsupported(this, s.presentation?.capabilities.fullscreen === false);
      }
    };
  });

/** Video PiP, or Document PiP where only that exists (the presentation plugin picks). */
const pipButtonClass = () =>
  once('PipButton', () => {
    const ButtonElement = buttonElementClass();
    return class PipButton extends ButtonElement {
      protected icons(): Record<string, IconNode> {
        return { pip: PictureInPicture2 };
      }
      protected activate(e: Event): void {
        this.ui?.dispatch('toggle-pip', {}, { type: e.type, source: 'otter-pip-button' });
      }
      protected render(s: Readonly<UiState>): void {
        const p = s.presentation;
        const on = p?.mode === 'pip' || p?.mode === 'docpip';
        this.show(on ? this.strings.exitPip : this.strings.pip, 'pip');
        this.button?.setAttribute('aria-pressed', String(on));
        unsupported(this, p === undefined || (p.capabilities.pip === false && p.capabilities.docpip === false));
      }
    };
  });

/** Theater mode: layout only, the host resizes on `data-otter-theater` (SPEC §15). */
const theaterButtonClass = () =>
  once('TheaterButton', () => {
    const ButtonElement = buttonElementClass();
    return class TheaterButton extends ButtonElement {
      protected icons(): Record<string, IconNode> {
        return { theater: Theater };
      }
      protected activate(e: Event): void {
        this.ui?.dispatch('toggle-theater', {}, { type: e.type, source: 'otter-theater-button' });
      }
      protected render(s: Readonly<UiState>): void {
        const on = s.presentation?.mode === 'theater';
        this.show(on ? this.strings.exitTheater : this.strings.theater, 'theater');
        this.button?.setAttribute('aria-pressed', String(on));
        unsupported(this, s.presentation?.capabilities.theater !== 'emulated');
      }
    };
  });

/** Page mini window close (SPEC §15): only in mini mode; the skin shows it on hover. */
const miniCloseClass = () =>
  once('MiniClose', () => {
    const ButtonElement = buttonElementClass();
    return class MiniClose extends ButtonElement {
      protected icons(): Record<string, IconNode> {
        return { close: X };
      }
      protected activate(e: Event): void {
        this.ui?.dispatch('exit-presentation', {}, { type: e.type, source: 'otter-mini-close' });
      }
      protected render(s: Readonly<UiState>): void {
        this.show(this.strings.closeMini, 'close');
        unsupported(this, s.presentation?.mode !== 'mini');
      }
    };
  });

/** Cast (Remote Playback API) and AirPlay: shown while a receiver is available, opens the picker. */
const remoteButtonClass = (target: 'cast' | 'airplay') =>
  once(target === 'cast' ? 'CastButton' : 'AirPlayButton', () => {
    const ButtonElement = buttonElementClass();
    return class RemoteButton extends ButtonElement {
      protected icons(): Record<string, IconNode> {
        return { remote: target === 'cast' ? Cast : Airplay };
      }
      protected activate(e: Event): void {
        this.ui?.dispatch(target === 'cast' ? 'open-cast-picker' : 'open-airplay-picker', {}, { type: e.type, source: `otter-${target}-button` });
      }
      protected render(s: Readonly<UiState>): void {
        const state = s[target] ?? 'unavailable';
        const on = state === 'connected';
        this.show(target === 'airplay' ? this.strings.airplay : on ? this.strings.stopCast : this.strings.cast, 'remote');
        this.button?.setAttribute('aria-pressed', String(on));
        this.toggleAttribute('data-connecting', state === 'connecting');
        unsupported(this, state === 'unavailable');
      }
    };
  });

/** ±N seconds (`seconds` attribute, default 10; negative goes back). Mobile centre controls. */
const seekButtonClass = () =>
  once('SeekButton', () => {
    const ButtonElement = buttonElementClass();
    return class SeekButton extends ButtonElement {
      get seconds(): number {
        const n = Number(this.getAttribute('seconds') ?? 10);
        return Number.isFinite(n) && n !== 0 ? n : 10;
      }
      protected icons(): Record<string, IconNode> {
        return this.seconds < 0 ? { back: RotateCcw } : { forward: RotateCw };
      }
      protected override extraCss(): string {
        return `.n { position: absolute; font: 700 9px/1 ${T.font}; top: 50%; left: 50%; transform: translate(-50%, -38%); pointer-events: none; }`;
      }
      protected override extraHtml(): string {
        return `<span class="n" aria-hidden="true">${Math.abs(this.seconds)}</span>`;
      }
      protected activate(e: Event): void {
        this.ui?.dispatch('seek-by', { seconds: this.seconds }, { type: e.type, source: 'otter-seek-button' });
      }
      protected render(s: Readonly<UiState>): void {
        const n = Math.abs(this.seconds);
        this.show(fill(this.seconds < 0 ? this.strings.seekBack : this.strings.seekForward, { n }), this.seconds < 0 ? 'back' : 'forward');
        if (this.button !== undefined) this.button.disabled = s.status !== 'ready' || s.live;
      }
    };
  });

/** Large centre play button, poster state only (UI-DESIGN §6.4). */
const bigPlayClass = () =>
  once('BigPlay', () => {
    const ButtonElement = buttonElementClass();
    return class BigPlay extends ButtonElement {
      protected icons(): Record<string, IconNode> {
        return { play: Play };
      }
      protected override extraCss(): string {
        return `:host { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
button { pointer-events: auto; width: 72px; height: 72px; border-radius: 50%; ${glass()} }
button svg { width: 32px; height: 32px; transform: translateX(2px); }
.tip { display: none; }
${glassFallback('button')}`;
      }
      protected activate(e: Event): void {
        this.ui?.dispatch('play', undefined, { type: e.type, source: 'otter-big-play' });
      }
      protected render(s: Readonly<UiState>): void {
        this.show(this.strings.play, 'play');
        // Poster state: loaded, never played (a decoded first frame does not count as started).
        const poster = s.status === 'ready' && s.paused && s.currentTime === 0 && !s.ended;
        this.hidden = !poster;
        if (this.button !== undefined) this.button.disabled = s.status !== 'ready';
      }
    };
  });

// ---- Time --------------------------------------------------------------------------------------

const timeDisplayClass = () =>
  once('TimeDisplay', () => {
    const Base = base();
    return class TimeDisplay extends Base {
      #text: HTMLElement | undefined;
      protected setup(): void {
        if (this.#text !== undefined) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>:host([hidden]){display:none}
:host{display:inline-flex;align-items:center;white-space:nowrap;font:500 13px/1 ${T.font};font-variant-numeric:tabular-nums;
  color:${T.fg};text-shadow:${T.textShadow}}
.d{color:${T.muted}}</style><span part="text"></span>`;
        this.#text = root.querySelector('span') as HTMLElement;
      }
      protected render(s: Readonly<UiState>): void {
        const t = this.#text;
        if (t === undefined) return;
        // Visual "1:15 / 1:30"; the slider carries the spoken form. Live shows the live badge instead.
        const text = s.live ? this.strings.live : `${formatTime(s.currentTime)} / ${formatTime(s.duration)}`;
        if (t.textContent === text) return;
        if (s.live) {
          t.textContent = text;
          return;
        }
        t.replaceChildren(`${formatTime(s.currentTime)} `, Object.assign(this.ownerDocument.createElement('span'), { className: 'd', textContent: `/ ${formatTime(s.duration)}` }));
        this.hidden = false;
      }
    };
  });

/** Progress bar (UI-DESIGN §6.2): track / buffered / played, hover thickening and preview card. */
const timeSliderClass = () =>
  once('TimeSlider', () => {
    const Base = base();
    return class TimeSlider extends Base {
      #input: HTMLInputElement | undefined;
      #card: HTMLElement | undefined;
      #dragging = false;
      #hoverTime: number | null = null;
      #last: Readonly<UiState> | undefined;
      /** Latest thumbnail request; older answers are dropped. */
      #thumbSeq = 0;
      #thumbView: Promise<(t: Thumbnail | null) => void> | undefined;
      protected setup(): void {
        if (this.#input !== undefined) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${rangeCss()}
:host { display: block; position: relative; flex: 1 0 100%; --otter-hit: 24px; }
:host([hidden]) { display: none; }
:host(:hover), :host([data-active]) { --otter-rail: 5px; }
.card { position: absolute; bottom: calc(100% + 10px); transform: translateX(-50%); display: grid; justify-items: center; gap: 4px;
  pointer-events: none; opacity: 0; transition: opacity ${T.fast} ${T.easeOut}; }
.card[data-show] { opacity: 1; }
.card { display: block; }
.thumb { position: relative; width: var(--otter-thumbnail-width, 160px); height: var(--otter-thumbnail-height, 90px); border-radius: ${T.radius};
  border: 2px solid rgb(255 255 255 / 0.85); background: rgb(0 0 0 / 0.6) no-repeat; box-shadow: ${T.shadow}; overflow: hidden; }
.card:not([data-thumb]) .thumb { width: auto; height: auto; border: none; background: none; box-shadow: none; overflow: visible; }
/* Without a thumbnail the time is a small version of the card (same frame and corner). */
.time { display: block; padding: 5px 10px; border-radius: ${T.radius}; border: 2px solid rgb(255 255 255 / 0.85); ${glass()}
  color: ${T.fg}; font: 600 12px/1.2 ${T.font}; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* With a thumbnail it sits inside the card's bottom-right corner (mockup). */
.card[data-thumb] .time { position: absolute; right: 6px; bottom: 6px; padding: 2px 6px; border: none; border-radius: ${T.radiusSm};
  background: rgb(0 0 0 / 0.65); backdrop-filter: none; -webkit-backdrop-filter: none; box-shadow: none; }
${glassFallback('.time')}
</style><div class="range" part="range"><div class="rail" part="rail"><i class="buffered"></i><i class="played"></i></div><input part="input" type="range" min="0" max="0" step="0.1" value="0"></div>
<div class="card" part="preview" aria-hidden="true"><div class="thumb" part="thumbnail"><span class="time" part="preview-time"></span></div></div>`;
        const input = root.querySelector('input') as HTMLInputElement;
        const range = root.querySelector('.range') as HTMLElement;
        this.#input = input;
        this.#card = root.querySelector('.card') as HTMLElement;
        input.addEventListener('input', () => {
          this.#dragging = true;
          this.toggleAttribute('data-active', true);
          this.#valueText(Number(input.value), Number(input.max));
          this.#played(Number(input.value), Number(input.max));
          this.#preview(Number(input.value));
        });
        input.addEventListener('change', (e) => {
          this.#dragging = false;
          this.removeAttribute('data-active');
          this.#preview(null);
          this.ui?.dispatch('seek', { time: Number(input.value) }, { type: e.type, source: 'otter-time-slider' });
        });
        // Arrows step 5 s (Shift: 10 s) instead of the input's 0.1 s step (UI-DESIGN §6.2).
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          const s = this.ui?.getState();
          if (s === undefined || input.disabled) return;
          e.preventDefault();
          const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1;
          const time = Math.min(s.duration, Math.max(0, s.currentTime + dir * (e.shiftKey ? 10 : 5)));
          this.ui?.dispatch('seek', { time }, { type: e.type, source: 'otter-time-slider' });
        });
        range.addEventListener('pointermove', (e) => {
          const max = Number(input.max);
          const r = range.getBoundingClientRect();
          if (max <= 0 || r.width <= 0) return;
          this.#hoverTime = Math.min(max, Math.max(0, ((e.clientX - r.left) / r.width) * max));
          this.#preview(this.#hoverTime);
        });
        range.addEventListener('pointerleave', () => {
          this.#hoverTime = null;
          if (!this.#dragging) this.#preview(this.#swipeTarget());
        });
      }
      #valueText(current: number, duration: number): void {
        this.#input?.setAttribute('aria-valuetext', fill(this.strings.timeOf, { current: speakTime(current), duration: speakTime(duration) }));
      }
      #played(current: number, duration: number): void {
        this.style.setProperty('--otter-played', `${duration > 0 ? Math.min(100, (current / duration) * 100) : 0}%`);
      }
      #swipeTarget(): number | null {
        const s = this.#last;
        const offset = s?.seekPreview ?? null;
        return s === undefined || offset === null ? null : Math.min(s.duration, Math.max(0, s.currentTime + offset));
      }
      /** Shows the preview card at `time` (null hides it). */
      #preview(time: number | null): void {
        const card = this.#card;
        const input = this.#input;
        if (card === undefined || input === undefined) return;
        const max = Number(input.max);
        if (time === null || max <= 0) {
          card.removeAttribute('data-show');
          this.#thumbSeq++;
          return;
        }
        const s = this.#last;
        const offset = s?.seekPreview ?? null;
        const label = offset !== null && this.#hoverTime === null ? `${offset >= 0 ? '+' : '−'}${formatTime(Math.abs(offset))} · ${formatTime(time)}` : formatTime(time);
        const t = card.querySelector('.time') as HTMLElement;
        if (t.textContent !== label) t.textContent = label;
        // Keep the card inside the bar: half its width from each end.
        const w = this.getBoundingClientRect().width;
        const half = Math.min(w / 2, (card.getBoundingClientRect().width || 160) / 2);
        card.style.left = `${Math.min(w - half, Math.max(half, (time / max) * w))}px`;
        card.setAttribute('data-show', '');
        const seq = ++this.#thumbSeq;
        const provider = findThumbnails(this);
        if (provider === undefined) return card.removeAttribute('data-thumb');
        // The drawing code is an on-demand chunk, loaded with the first thumbnail source.
        this.#thumbView ??= import('./thumb-view.js').then((m) => m.createThumbView(card));
        void Promise.all([provider.at(time), this.#thumbView]).then(([t, show]) => seq === this.#thumbSeq && show(t));
      }
      protected render(s: Readonly<UiState>): void {
        this.#last = s;
        const input = this.#input;
        if (input === undefined) return;
        if (input.getAttribute('aria-label') !== this.strings.seek) input.setAttribute('aria-label', this.strings.seek);
        const seekable = Number.isFinite(s.duration) && s.duration > 0 && !s.live;
        input.disabled = !seekable;
        if (!seekable) {
          this.#preview(null);
          return;
        }
        if (input.max !== String(s.duration)) input.max = String(s.duration);
        if (!this.#dragging) {
          input.value = String(s.currentTime);
          this.#valueText(s.currentTime, s.duration);
          this.#played(s.currentTime, s.duration);
        }
        this.style.setProperty('--otter-buffered', `${Math.min(100, (s.bufferedEnd / s.duration) * 100)}%`);
        // Swipe seek preview (chrome slice): where the release would land.
        if (this.#hoverTime === null && !this.#dragging) {
          this.toggleAttribute('data-active', (s.seekPreview ?? null) !== null);
          this.#preview(this.#swipeTarget());
        }
      }
    };
  });

const volumeSliderClass = () =>
  once('VolumeSlider', () => {
    const Base = base();
    return class VolumeSlider extends Base {
      #input: HTMLInputElement | undefined;
      protected setup(): void {
        if (this.#input !== undefined) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${rangeCss()}
:host { display: inline-flex; align-items: center; width: var(--otter-volume-width, 72px); --otter-rail: 4px; --otter-thumb: 12px; --otter-thumb-scale: 1;
  transition: width ${T.show} ${T.easeOut}, opacity ${T.show} ${T.easeOut}; }
:host([hidden]), :host([data-otter-unsupported]) { display: none; }
.range { width: 100%; }
.played { background: ${T.fg}; }
</style><div class="range" part="range"><div class="rail" part="rail"><i class="played"></i></div><input part="input" type="range" min="0" max="1" step="0.05" value="1"></div>`;
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
        this.style.setProperty('--otter-played', `${value * 100}%`);
        input.setAttribute('aria-valuetext', s.muted ? this.strings.announceMuted : speakVolume(s.volume));
      }
    };
  });

/**
 * Live badge (UI-DESIGN §6.1 / §10): at the live edge a status "● Live"; more than 3 s behind it
 * becomes a "Back to live" button (seek-to-live, then play if paused, in the same click).
 */
/**
 * Live badge / Back to live capsule. Only live sources show it, so its view loads when the source
 * is live (live-view.ts); until then the element is hidden as unsupported.
 */
const liveIndicatorClass = () =>
  once('LiveIndicator', () => {
    const Base = base();
    return class LiveIndicator extends Base {
      #view: Promise<(s: Readonly<UiState>) => void> | undefined;
      protected setup(): void {
        // Built by the view when the source is live.
      }
      protected render(s: Readonly<UiState>): void {
        unsupported(this, !s.live);
        if (!s.live) return;
        this.#view ??= import('./live-view.js').then(({ mountLiveIndicator }) =>
          mountLiveIndicator(this, this.shadowRoot ?? this.attachShadow({ mode: 'open' }), () => this.ui, () => this.strings, { T, icon, LiveDot }),
        );
        void this.#view.then((view) => {
          const now = this.ui?.getState();
          if (now !== undefined) view(now);
        });
      }
    };
  });

// ---- Picture layers ------------------------------------------------------------------------------

/** Visual tooltip for the element named by `for` (by id, in the same tree); the name stays aria-label. */
const tooltipClass = () =>
  once('Tooltip', () => {
    const Base = base();
    return class Tooltip extends Base {
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
span { display: block; padding: 4px 8px; border-radius: ${T.radiusSm}; white-space: nowrap; ${glass()}
  color: ${T.fg}; font: 500 11px/1.3 ${T.font}; }
${glassFallback('span')}</style><span part="tooltip" role="tooltip"></span>`;
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
    };
  });

/** Gesture surface over the picture: the dimming layer (brightness gesture). */
const gestureClass = () =>
  once('Gesture', () => {
    const Base = base();
    return class Gesture extends Base {
      #dim: HTMLElement | undefined;
      protected setup(): void {
        if (this.#dim !== undefined) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>:host { position: absolute; inset: 0; display: block; }
.dim { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; transition: opacity ${T.show}; }
${REDUCED_MOTION}</style><div class="dim" part="dim"></div><slot></slot>`;
        this.#dim = root.querySelector('.dim') as HTMLElement;
      }
      protected render(s: Readonly<UiState>): void {
        const dim = this.#dim;
        if (dim === undefined) return;
        const opacity = String(Math.max(0, Math.min(0.8, 1 - (s.brightness ?? 1))));
        if (dim.style.opacity !== opacity) dim.style.opacity = opacity;
      }
    };
  });

const posterClass = () =>
  once('Poster', () => {
    const Base = base();
    return class Poster extends Base {
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
    };
  });

/** Loading spinner, shown only when loading lasts longer than 800 ms (no flicker, UI-DESIGN §6.4). */
const spinnerClass = () =>
  once('Spinner', () => {
    const Base = base();
    return class Spinner extends Base {
      #el: HTMLElement | undefined;
      #timer: ReturnType<typeof setTimeout> | undefined;
      protected setup(): void {
        if (this.#el !== undefined) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>:host { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
:host([hidden]) { display: none; }
div { width: 48px; height: 48px; color: ${T.accent}; filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.5)); }
svg { width: 100%; height: 100%; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { svg { animation-duration: 3s; } }</style><div part="spinner" role="progressbar">${icon(SpinnerRing)}</div>`;
        this.#el = root.querySelector('div') as HTMLElement;
        this.hidden = true;
      }
      protected render(s: Readonly<UiState>): void {
        const busy = s.status === 'loading' || (s.waiting && !s.paused && s.status === 'ready');
        this.#el?.setAttribute('aria-label', this.strings.loading);
        if (!busy) {
          if (this.#timer !== undefined) clearTimeout(this.#timer);
          this.#timer = undefined;
          this.hidden = true;
          return;
        }
        if (this.hidden && this.#timer === undefined) {
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.hidden = false;
          }, Number(this.getAttribute('delay') ?? 800));
        }
      }
    };
  });

/**
 * Centre feedback (UI-DESIGN §6.4): "+10s" after a seek jump, volume / brightness level, the
 * held rate. Derived from state changes only; decorative (the announcer speaks).
 */
const feedbackClass = () =>
  once('Feedback', () => {
    const Base = base();
    return class Feedback extends Base {
      #badge: HTMLElement | undefined;
      #prev: Readonly<UiState> | undefined;
      #timer: ReturnType<typeof setTimeout> | undefined;
      protected setup(): void {
        if (this.#badge !== undefined) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>:host { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.b { min-width: 72px; padding: 12px 16px; border-radius: 999px; ${glass()} color: ${T.fg}; font: 600 15px/1 ${T.font};
  text-align: center; opacity: 0; transform: scale(0.8); transition: opacity ${T.hide} ${T.easeIn}, transform ${T.hide} ${T.easeIn}; }
.b[data-show] { opacity: 1; transform: scale(1); transition-duration: ${T.show}; transition-timing-function: ${T.easeOut}; }
.b[data-kind="rate"] { position: absolute; top: 16px; }
.level { display: block; width: 96px; height: 4px; margin-top: 8px; border-radius: 2px; background: ${T.track}; overflow: hidden; }
.level > i { display: block; height: 100%; background: ${T.fg}; }
${glassFallback('.b')}
${REDUCED_MOTION}</style><div class="b" part="badge" aria-hidden="true"></div>`;
        this.#badge = root.querySelector('.b') as HTMLElement;
      }
      #flash(kind: string, text: string, level?: number): void {
        const b = this.#badge;
        if (b === undefined) return;
        b.dataset['kind'] = kind;
        b.replaceChildren(text);
        if (level !== undefined) {
          const bar = this.ownerDocument.createElement('span');
          bar.className = 'level';
          const fillEl = this.ownerDocument.createElement('i');
          fillEl.style.width = `${Math.round(level * 100)}%`;
          bar.append(fillEl);
          b.append(bar);
        }
        b.setAttribute('data-show', '');
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        this.#timer = setTimeout(() => b.removeAttribute('data-show'), kind === 'rate' ? 1200 : 500);
      }
      protected render(s: Readonly<UiState>): void {
        const p = this.#prev;
        this.#prev = s;
        if (p === undefined || s.status !== 'ready' || p.status !== 'ready') return;
        const jump = s.currentTime - p.currentTime;
        // A seek jump (not playback progress): show the offset for jumps a hotkey or double tap makes.
        if (s.seeking && !p.seeking && Math.abs(jump) >= 2 && Math.abs(jump) <= 60) {
          this.#flash('seek', `${jump > 0 ? '+' : '−'}${Math.round(Math.abs(jump))}s`);
        } else if (s.volume !== p.volume || s.muted !== p.muted) {
          this.#flash('volume', s.muted ? this.strings.announceMuted : `${Math.round(s.volume * 100)}%`, s.muted ? 0 : s.volume);
        } else if ((s.brightness ?? 1) !== (p.brightness ?? 1)) {
          this.#flash('brightness', `${Math.round((s.brightness ?? 1) * 100)}%`, s.brightness ?? 1);
        } else if (s.playbackRate !== p.playbackRate && s.playbackRate !== 1) {
          this.#flash('rate', `${rateLabel(s.playbackRate)} ▶▶`);
        }
      }
    };
  });

/** Fatal error card with retry (reloads the current source). */
/**
 * Error card: shown only when playback fails, so its view loads then (error-view.ts). Until the
 * view is in, the element is just hidden.
 */
const errorCardClass = () =>
  once('ErrorCard', () => {
    const Base = base();
    return class ErrorCard extends Base {
      #view: Promise<(s: Readonly<UiState>) => void> | undefined;
      protected setup(): void {
        this.hidden = true;
      }
      protected render(s: Readonly<UiState>): void {
        const fatal = s.status === 'error' && s.error !== null;
        this.hidden = !fatal;
        if (!fatal) return;
        this.#view ??= import('./error-view.js').then(({ mountErrorCard }) =>
          mountErrorCard(
            this.shadowRoot ?? this.attachShadow({ mode: 'open' }),
            () => this.strings,
            (e) => {
              const now = this.ui?.getState();
              if (now?.source != null) this.ui?.dispatch('load', { source: now.source, options: { autoplay: true } }, { type: e.type, source: 'otter-error' });
            },
            { T, glass, glassFallback, icon },
          ),
        );
        void this.#view.then((view) => {
          const now = this.ui?.getState();
          if (now !== undefined) view(now);
        });
      }
    };
  });

/** aria-live region: announces state changes the user caused or needs to know about. */
const announcerClass = () =>
  once('Announcer', () => {
    const Base = base();
    return class Announcer extends Base {
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
        // Re-announce identical text: clear first, set shortly after.
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
        const fs = s.presentation?.mode === 'fullscreen';
        if (fs !== (p.presentation?.mode === 'fullscreen') && s.presentation !== undefined) this.say(fs ? t.announceFullscreen : t.announceExitFullscreen);
        if (s.error !== null && s.error !== p.error && s.error.fatal) this.say(fill(t.announceError, { label: s.error.details }));
      }
    };
  });

// ---- Menus -----------------------------------------------------------------------------------------

/** menuitemradio inside an otter-menu. `value`, `checked` and the text content are the API. */
const menuItemClass = () =>
  once('MenuItem', () =>
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
    },
  );

const menuCss = (): string => `
:host { position: relative; }
.panel { position: absolute; bottom: calc(100% + 8px); right: 0; z-index: 5; box-sizing: border-box;
  min-width: var(--otter-menu-min-width, 160px); width: var(--otter-menu-panel-width, auto);
  max-height: var(--otter-menu-max-height, 60vh); overflow: hidden auto; overscroll-behavior: contain;
  padding: 6px 0; border-radius: ${T.radiusLg}; ${glass()} color: ${T.fg}; font: 500 14px/1.2 ${T.font};
  scrollbar-width: thin; scrollbar-color: rgb(255 255 255 / 0.3) transparent;
  opacity: 0; transform: translateY(8px); transition: opacity 100ms ${T.easeIn}, transform 100ms ${T.easeIn}; }
.panel[hidden] { display: none; }
.panel[data-open] { opacity: 1; transform: none; transition: opacity ${T.show} ${T.easeOut}, transform ${T.show} ${T.easeOut}; }
.view[data-enter="forward"] { animation: in-f ${T.show} ${T.easeOut}; }
.view[data-enter="back"] { animation: in-b ${T.show} ${T.easeOut}; }
@keyframes in-f { from { transform: translateX(24px); opacity: 0; } }
@keyframes in-b { from { transform: translateX(-24px); opacity: 0; } }
[role="group"] > .gh { padding: 10px 16px 4px; font: 600 11px/1 ${T.font}; letter-spacing: 0.06em; text-transform: uppercase; color: ${T.dim}; }
[role^="menuitem"], ::slotted(otter-menu-item) { box-sizing: border-box; display: flex; align-items: center; gap: 12px;
  min-height: var(--otter-menu-row, 40px); padding: 0 16px; cursor: pointer; outline: none; position: relative; }
[role^="menuitem"]:hover { background: ${T.hover}; }
[role^="menuitem"]:focus-visible { box-shadow: inset 0 0 0 2px ${T.accentDeep}; border-radius: 6px; }
.ic { width: 24px; height: 24px; flex: none; color: ${T.fg}; }
.ic:empty { visibility: hidden; }
.ic svg { width: 24px; height: 24px; }
[role="menuitemradio"] .ic svg { color: ${T.accent}; }
.lb { flex: 1; min-width: 0; display: grid; gap: 2px; }
.lb small { font: 400 12px/1.2 ${T.font}; color: ${T.muted}; }
.val { color: ${T.muted}; font: 400 13px/1 ${T.font}; white-space: nowrap; }
.val[data-on] { color: ${T.accent}; }
.chev { width: 18px; height: 18px; color: ${T.muted}; flex: none; }
.chev svg, .back svg { width: 18px; height: 18px; }
.back { min-height: 44px; border-bottom: 1px solid ${T.glassBorder}; margin-bottom: 4px; font-weight: 600; }
.seg { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 12px 8px; }
.seg [role="menuitemradio"] { flex: 1 0 auto; justify-content: center; min-height: 30px; padding: 0 8px; border-radius: 999px;
  background: rgb(255 255 255 / 0.08); font: 600 12px/1 ${T.font}; gap: 0; }
.seg [role="menuitemradio"][aria-checked="true"] { background: ${T.accent}; color: #0b1b24; }
.switch { width: 34px; height: 20px; border-radius: 999px; background: rgb(255 255 255 / 0.25); position: relative; flex: none;
  transition: background ${T.fast}; }
.switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff;
  transition: transform ${T.fast} ${T.easeOut}; }
[aria-checked="true"] > .switch { background: ${T.accent}; }
[aria-checked="true"] > .switch::after { transform: translateX(14px); }
.preview { margin: 4px 16px 8px; padding: 18px 8px; border-radius: ${T.radius}; text-align: center;
  background: linear-gradient(135deg, #2b3a4d, #10161e); }
.preview span { font-size: calc(15px * var(--otter-cue-user-scale, 1)); padding: 2px 8px; border-radius: 4px;
  color: var(--otter-cue-user-color, #fff); background: var(--otter-cue-user-background, rgb(0 0 0 / 0.55));
  text-shadow: var(--otter-cue-user-shadow, 0 0 4px rgb(0 0 0 / 0.9)); font-family: var(--otter-cue-user-font, inherit); }
${glassFallback('.panel')}
${REDUCED_MOTION}
`;

/** Text or icon trigger opening a menu panel (WAI-ARIA APG menu button). */
const menuClass = () =>
  once('Menu', () => {
    const Base = base();
    /**
     * Menu button + menu (WAI-ARIA APG): Enter / Space / ArrowDown open and focus the checked item,
     * arrows / Home / End move (roving tabindex), Enter / Space choose, Esc and Tab close and
     * return focus to the trigger. Fires `otter-select` with { group, value }.
     */
    class Menu extends Base {
      protected trigger: HTMLButtonElement | undefined;
      protected list: HTMLElement | undefined;
      #tip: HTMLElement | undefined;
      readonly menuId = `otter-menu-${++menuIds}`;
      protected setup(): void {
        if (this.trigger !== undefined) return;
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${buttonCss()}${menuCss()}${this.extraCss()}</style><button part="button trigger" type="button" aria-haspopup="menu" aria-expanded="false"></button><span class="tip" part="tooltip" aria-hidden="true"></span><div class="panel" part="menu" role="menu" hidden><slot></slot></div>`;
        const trigger = root.querySelector('button') as HTMLButtonElement;
        const list = root.querySelector('[role="menu"]') as HTMLElement;
        this.trigger = trigger;
        this.list = list;
        this.#tip = root.querySelector('.tip') as HTMLElement;
        list.id = this.menuId;
        trigger.setAttribute('aria-controls', this.menuId);
        trigger.addEventListener('click', () => (this.open ? this.close(true) : this.openMenu('checked')));
        trigger.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            this.openMenu(e.key === 'ArrowUp' ? 'last' : 'checked');
          }
        });
        list.addEventListener('keydown', (e) => this.onKey(e));
        list.addEventListener('click', (e) => {
          const item = this.itemFrom(e);
          if (item !== undefined) this.activateItem(item);
        });
        // Clicking elsewhere closes the menu.
        this.ownerDocument.addEventListener('pointerdown', (e) => {
          if (this.open && !e.composedPath().includes(this)) this.close(false);
        });
      }
      protected extraCss(): string {
        return '';
      }
      get open(): boolean {
        return this.list !== undefined && !this.list.hidden;
      }
      protected items(): HTMLElement[] {
        const slot = this.list?.querySelector('slot');
        const slotted = (slot?.assignedElements() ?? []).filter((e): e is HTMLElement => (e.getAttribute('role') ?? '').startsWith('menuitem'));
        const own = [...(this.list?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
        return [...own, ...slotted];
      }
      protected itemFrom(e: Event): HTMLElement | undefined {
        for (const n of e.composedPath()) {
          if (n === this.list) return undefined;
          if (n instanceof HTMLElement && (n.getAttribute('role') ?? '').startsWith('menuitem')) return n;
        }
        return undefined;
      }
      openMenu(focus: 'checked' | 'first' | 'last'): void {
        const list = this.list;
        if (list === undefined) return;
        this.beforeOpen();
        list.hidden = false;
        // Next frame: let the panel lay out before it animates in.
        requestAnimationFrame(() => list.setAttribute('data-open', ''));
        this.trigger?.setAttribute('aria-expanded', 'true');
        this.ui?.dispatch('open-menu', { id: this.menuId });
        this.focusIn(focus);
      }
      protected focusIn(focus: 'checked' | 'first' | 'last'): void {
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
        this.list.removeAttribute('data-open');
        this.trigger?.setAttribute('aria-expanded', 'false');
        if (this.ui?.getState().menu === this.menuId) this.ui.dispatch('open-menu', { id: null });
        this.afterClose();
        if (returnFocus) this.trigger?.focus();
      }
      protected afterClose(): void {}
      /** Click / Enter / Space on an item. Radio items choose and close by default. */
      protected activateItem(item: HTMLElement): void {
        this.choose(item);
        this.close(true);
      }
      protected choose(item: HTMLElement): void {
        this.dispatchEvent(
          new CustomEvent('otter-select', {
            bubbles: true,
            composed: true,
            detail: { group: item.dataset['group'] ?? item.closest('[data-group]')?.getAttribute('data-group') ?? '', value: item.getAttribute('value') ?? item.dataset['value'] ?? '' },
          }),
        );
      }
      protected currentItem(): { items: HTMLElement[]; index: number } {
        const items = this.items();
        const active = (this.shadowRoot?.activeElement as HTMLElement | null) ?? (this.ownerDocument.activeElement as HTMLElement | null);
        return { items, index: items.findIndex((i) => i === active) };
      }
      protected onKey(e: KeyboardEvent): void {
        const { items, index } = this.currentItem();
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
            if (index >= 0) this.activateItem(items[index] as HTMLElement);
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
        this.label(s);
        // Another menu opened, or Esc went through the chrome plugin.
        if (this.open && s.menu !== undefined && s.menu !== this.menuId) this.close(false);
      }
      protected label(_s: Readonly<UiState>): void {
        this.setTrigger(this.getAttribute('label') ?? '', icon(Settings));
      }
      /** Trigger accessible name, tooltip and content (icon markup or text). */
      protected setTrigger(label: string, content: string, text = false): void {
        const t = this.trigger;
        if (t === undefined) return;
        if (t.getAttribute('aria-label') !== label) {
          t.setAttribute('aria-label', label);
          if (this.#tip !== undefined) this.#tip.textContent = label;
        }
        if (t.dataset['content'] !== content) {
          t.dataset['content'] = content;
          t.classList.toggle('text', text);
          if (text) t.textContent = content;
          else t.innerHTML = `<span class="icon">${content.replace('<svg ', '<svg data-on ')}</span>`;
        }
      }
      /** A radio row: check slot, label (+ detail line). */
      protected radioRow(group: string, o: MenuOption): HTMLElement {
        const doc = this.ownerDocument;
        const item = doc.createElement('div');
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(o.checked));
        item.setAttribute('value', o.value);
        item.dataset['group'] = group;
        item.dataset['key'] = `${group}:${o.value}`;
        item.tabIndex = -1;
        const ic = doc.createElement('span');
        ic.className = 'ic';
        if (o.checked) ic.innerHTML = icon(Check);
        const lb = doc.createElement('span');
        lb.className = 'lb';
        lb.append(o.label);
        if (o.detail !== undefined) lb.append(Object.assign(doc.createElement('small'), { textContent: o.detail }));
        item.append(ic, lb);
        return item;
      }
    }
    return Menu;
  });

/** Text menu button with one radio list (UI-DESIGN §6.1 right group: "1080P", "1.0x"). */
const textMenuClass = () =>
  once('TextMenu', () => {
    const Menu = menuClass();
    abstract class TextMenu extends Menu {
      #signature = '';
      protected abstract group(s: Readonly<UiState>): MenuGroup | undefined;
      protected abstract triggerText(s: Readonly<UiState>): string;
      protected abstract dispatchValue(value: string): void;
      constructor() {
        super();
        this.addEventListener('otter-select', (e) => this.dispatchValue((e as CustomEvent<{ value: string }>).detail.value));
      }
      protected override beforeOpen(): void {
        const s = this.ui?.getState();
        if (s !== undefined) this.#build(s);
      }
      #build(s: Readonly<UiState>): void {
        const list = this.list;
        const g = this.group(s);
        if (list === undefined || g === undefined) return;
        const signature = JSON.stringify(g);
        if (signature === this.#signature) return;
        this.#signature = signature;
        const group = this.ownerDocument.createElement('div');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', g.label);
        group.dataset['group'] = g.id;
        group.append(...g.options.map((o) => this.radioRow(g.id, o)));
        const slot = list.querySelector('slot');
        list.replaceChildren(group, ...(slot === null ? [] : [slot]));
      }
      protected override render(s: Readonly<UiState>): void {
        super.render(s);
        unsupported(this, this.group(s) === undefined);
        if (this.open) this.#build(s);
      }
    }
    return TextMenu;
  });

const qualityMenuClass = () =>
  once('QualityMenu', () => {
    const TextMenu = textMenuClass();
    return class QualityMenu extends TextMenu {
      protected group(s: Readonly<UiState>): MenuGroup | undefined {
        return s.tracks.quality === 'selectable' && s.tracks.video.length > 1 ? qualityGroup(s, this.strings) : undefined;
      }
      protected triggerText(s: Readonly<UiState>): string {
        return qualityLabel(s, s.quality === 'auto' ? s.activeQuality : s.quality) ?? this.strings.qualityAuto;
      }
      protected dispatchValue(value: string): void {
        this.ui?.dispatch('select-quality', { id: value }, { type: 'click', source: 'otter-quality-menu' });
      }
      protected override label(s: Readonly<UiState>): void {
        const text = this.triggerText(s);
        this.setTrigger(`${this.strings.quality}: ${text}`, text, true);
      }
    };
  });

const speedMenuClass = () =>
  once('SpeedMenu', () => {
    const TextMenu = textMenuClass();
    return class SpeedMenu extends TextMenu {
      protected group(s: Readonly<UiState>): MenuGroup | undefined {
        return speedGroup(s, this.strings);
      }
      protected triggerText(s: Readonly<UiState>): string {
        return rateLabel(s.playbackRate);
      }
      protected dispatchValue(value: string): void {
        this.ui?.dispatch('set-playback-rate', { rate: Number(value) }, { type: 'click', source: 'otter-speed-menu' });
      }
      protected override label(s: Readonly<UiState>): void {
        const text = this.triggerText(s);
        this.setTrigger(`${this.strings.speed}: ${text}`, text, true);
      }
    };
  });

export type SettingsView = 'root' | 'quality' | 'audio' | 'captions' | 'caption-style' | 'picture';

/**
 * Settings (UI-DESIGN §7): a two-level menu. Level one: rows "icon + label + current value +
 * chevron" for quality / audio / subtitles / caption style, the speed segmented control, and the
 * stats switch (when the player has an otter-stats element). Level two: a back row and the
 * options. ArrowRight / Enter open a row, ArrowLeft / the back row return, focus never drops.
 */
const settingsMenuClass = () =>
  once('SettingsMenu', () => {
    const Menu = menuClass();
    return class SettingsMenu extends Menu {
      #view: SettingsView = 'root';
      #signature = '';
      #returnTo: string | undefined;
      /** Level-two views: an on-demand chunk, requested when the menu opens. */
      #levels: typeof import('./settings-level.js') | undefined;
      #loading: Promise<void> | undefined;
      #loadLevels(): Promise<void> {
        this.#loading ??= import('./settings-level.js').then((m) => {
          this.#levels = m;
          // Level one has rows from the chunk too (Picture): rebuild it once it is here.
          const s = this.ui?.getState();
          if (s !== undefined && this.open && this.#view === 'root') {
            this.#signature = '';
            this.#build(s, undefined);
          }
        });
        return this.#loading;
      }
      #levelHost(): import('./settings-level.js').LevelHost {
        return {
          doc: this.ownerDocument,
          strings: this.strings,
          el: this,
          menuId: this.menuId,
          radioRow: (group, o) => this.radioRow(group, o),
          cueLayer: () => playerRoot(this)?.querySelector<HTMLElement>('[data-otter-cues]') ?? null,
        };
      }
      constructor() {
        super();
        this.addEventListener('otter-select', (e) => {
          const { group, value } = (e as CustomEvent<{ group: string; value: string }>).detail;
          const trigger = { type: 'click', source: 'otter-settings-menu' };
          if (group === 'quality') this.ui?.dispatch('select-quality', { id: value }, trigger);
          else if (group === 'speed') this.ui?.dispatch('set-playback-rate', { rate: Number(value) }, trigger);
          else if (group === 'captions') this.ui?.dispatch('select-text-track', { id: value === '' ? null : value }, trigger);
          else if (group === 'audio') this.ui?.dispatch('select-audio-track', { id: value }, trigger);
          // Level-two items (caption style, picture) carry their action: [type, payload].
          else if (value.startsWith('[')) {
            const [type, payload] = JSON.parse(value) as [keyof UiActions, never];
            this.ui?.dispatch(type, payload, trigger);
          }
        });
      }
      protected override extraCss(): string {
        return `.panel { width: var(--otter-menu-width, 280px); }`;
      }
      protected override label(): void {
        this.setTrigger(this.strings.settings, icon(Settings));
      }
      protected override beforeOpen(): void {
        void this.#loadLevels();
        this.#view = 'root';
        this.#signature = '';
        const s = this.ui?.getState();
        if (s !== undefined) this.#build(s, undefined);
      }
      protected override afterClose(): void {
        this.#view = 'root';
      }
      #stats(): HTMLElement | null {
        return playerRoot(this)?.querySelector<HTMLElement>('otter-stats') ?? null;
      }
      #go(view: SettingsView, from?: string): void {
        const s = this.ui?.getState();
        if (s === undefined) return;
        const back = view === 'root';
        this.#returnTo = back ? this.#returnTo : from;
        const focusKey = back ? `row:${this.#view}` : undefined;
        this.#view = view;
        this.#signature = '';
        const show = (): void => {
          this.#build(s, back ? 'back' : 'forward');
          const list = this.list;
          const target = focusKey === undefined ? undefined : byKey(list, focusKey);
          if (target !== null && target !== undefined) this.focusItem(target);
          else this.focusIn('checked');
        };
        // Usually loaded since the menu opened; otherwise the level appears when it arrives.
        if (back || this.#levels !== undefined) return show();
        void this.#loadLevels().then(() => {
          if (this.#view === view && this.open) show();
        });
      }
      protected override activateItem(item: HTMLElement): void {
        const action = item.dataset['action'];
        if (action === 'back') return this.#go('root');
        if (action === 'open') return this.#go(item.dataset['view'] as SettingsView, item.dataset['key']);
        if (action === 'stats') {
          const stats = this.#stats();
          if (stats !== null) stats.hidden = !stats.hidden;
          item.setAttribute('aria-checked', String(stats !== null && !stats.hidden));
          return;
        }
        this.choose(item);
        const group = item.dataset['group'] ?? '';
        // Picking a value in a list view goes back to level one, on that row (YouTube style);
        // segmented controls and caption style stay where they are.
        if (this.#view === 'quality' || this.#view === 'audio' || this.#view === 'captions') this.#go('root');
        else if (group === 'speed' || group.startsWith('caption-')) {
          const key = item.dataset['key'];
          queueMicrotask(() => {
            const again = key === undefined ? null : byKey(this.list, key);
            if (again !== null && again !== undefined) this.focusItem(again);
          });
        }
      }
      protected override onKey(e: KeyboardEvent): void {
        const { items, index } = this.currentItem();
        const item = items[index];
        if (item !== undefined && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          const seg = item.closest('.seg');
          if (seg !== null) {
            // Inside a segmented control the horizontal arrows move between segments.
            const segs = [...seg.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
            const i = segs.indexOf(item);
            const next = segs[i + (e.key === 'ArrowRight' ? 1 : -1)];
            e.preventDefault();
            if (next !== undefined) this.focusItem(next);
            return;
          }
          if (e.key === 'ArrowRight' && item.dataset['action'] === 'open') {
            e.preventDefault();
            this.activateItem(item);
            return;
          }
          if (e.key === 'ArrowLeft' && this.#view !== 'root') {
            e.preventDefault();
            this.#go('root');
            return;
          }
        }
        super.onKey(e);
      }
      #build(s: Readonly<UiState>, enter: 'forward' | 'back' | undefined): void {
        const list = this.list;
        if (list === undefined) return;
        const levels = this.#levels;
        if (this.#view !== 'root' && levels === undefined) return;
        const groups = settingsGroups(s, this.strings);
        const signature = JSON.stringify([this.#view, groups, s.captionStyle ?? null, s.picture ?? null, this.#stats()?.hidden ?? null]);
        if (signature === this.#signature) return;
        this.#signature = signature;
        const focused = (this.shadowRoot?.activeElement as HTMLElement | null)?.dataset['key'];
        const view = this.ownerDocument.createElement('div');
        view.className = 'view';
        if (enter !== undefined) view.dataset['enter'] = enter;
        view.append(
          ...(this.#view === 'root' || levels === undefined
            ? this.#root(s, groups)
            : levels.buildLevel(this.#levelHost(), this.#view, s, groups, { icon, ChevronLeft, ChevronRight })),
        );
        const slot = list.querySelector('slot');
        list.replaceChildren(view, ...(slot === null ? [] : [slot]));
        const refocus = focused === undefined ? null : byKey(list, focused);
        if (refocus !== null && this.open) this.focusItem(refocus);
      }
      #row(key: string, iconNode: IconNode, label: string, value: string, view: SettingsView): HTMLElement {
        const doc = this.ownerDocument;
        const item = doc.createElement('div');
        item.setAttribute('role', 'menuitem');
        item.setAttribute('aria-haspopup', 'menu');
        item.dataset['action'] = 'open';
        item.dataset['view'] = view;
        item.dataset['key'] = key;
        item.tabIndex = -1;
        item.innerHTML = `<span class="ic">${icon(iconNode)}</span><span class="lb"></span><span class="val"></span><span class="chev">${icon(ChevronRight)}</span>`;
        (item.querySelector('.lb') as HTMLElement).textContent = label;
        (item.querySelector('.val') as HTMLElement).textContent = value;
        // The current value is part of the item's name ("Quality, Auto (720P)").
        item.setAttribute('aria-label', `${label}, ${value}`);
        return item;
      }
      #root(s: Readonly<UiState>, groups: MenuGroup[]): HTMLElement[] {
        const doc = this.ownerDocument;
        const t = this.strings;
        const out: HTMLElement[] = [];
        const checked = (id: string): string => groups.find((g) => g.id === id)?.options.find((o) => o.checked)?.label ?? '';
        if (groups.some((g) => g.id === 'quality')) out.push(this.#row('row:quality', Settings2, t.quality, checked('quality'), 'quality'));
        // Speed: segmented control in place (UI-DESIGN §7).
        const speed = groups.find((g) => g.id === 'speed');
        if (speed !== undefined) {
          const group = doc.createElement('div');
          group.setAttribute('role', 'group');
          group.dataset['group'] = 'speed';
          const head = doc.createElement('div');
          head.className = 'gh';
          head.id = `${this.menuId}-speed`;
          head.setAttribute('role', 'presentation');
          head.textContent = t.speed;
          group.setAttribute('aria-labelledby', head.id);
          const seg = doc.createElement('div');
          seg.className = 'seg';
          for (const o of speed.options) {
            const b = doc.createElement('div');
            b.setAttribute('role', 'menuitemradio');
            b.setAttribute('aria-checked', String(o.checked));
            b.setAttribute('value', o.value);
            b.dataset['group'] = 'speed';
            b.dataset['key'] = `speed:${o.value}`;
            b.tabIndex = -1;
            b.textContent = o.value === '1' ? '1.0' : o.value;
            b.setAttribute('aria-label', o.label);
            seg.append(b);
          }
          group.append(head, seg);
          out.push(group);
        }
        if (groups.some((g) => g.id === 'audio')) out.push(this.#row('row:audio', AudioLines, t.audio, checked('audio'), 'audio'));
        if (groups.some((g) => g.id === 'captions')) {
          const captionsRow = this.#row('row:captions', Captions, t.captions, checked('captions'), 'captions');
          // An enabled track reads in the accent colour (UI-DESIGN §10 "selected").
          captionsRow.querySelector('.val')?.toggleAttribute('data-on', (s.textTrack ?? null) !== null);
          out.push(captionsRow);
          const custom = Object.keys(s.captionStyle ?? {}).length > 0;
          out.push(this.#row('row:caption-style', Type, t.captionStyle, custom ? '✓' : t.styleDefault, 'caption-style'));
        }
        // Picture and the stats switch: built by the level-two chunk (loading since the menu opened).
        const levels = this.#levels;
        if (levels !== undefined) out.push(...levels.extraRows(this.#levelHost(), s, { icon, ChevronLeft, ChevronRight }, this.#stats()));
        return out;
      }
      protected override render(s: Readonly<UiState>): void {
        super.render(s);
        // Keep an open menu current (e.g. "Auto (720P)" while ABR switches, the style preview,
        // the picture page while zooming with a gesture).
        if (this.open) this.#build(s, undefined);
      }
    };
  });

// ---- Stats ------------------------------------------------------------------------------------

/** Stats for nerds (UI-DESIGN §8): grouped two-column panel with copy and close. */
/**
 * Stats panel: hidden until the user asks for it, so its view (markup, CSS, rows) loads on first
 * show. Helpers are handed over instead of imported: a value import from a module the main chunk
 * also uses would make it a shared chunk (side-effects gate).
 */
const statsClass = () =>
  once('Stats', () => {
    const Base = base();
    return class Stats extends Base {
      static observedAttributes: readonly string[] = ['hidden'];
      #view: ((s: Readonly<UiState>) => void) | undefined;
      #loading = false;
      protected setup(): void {
        // Built by the view on first show.
      }
      attributeChangedCallback(): void {
        const s = this.ui?.getState();
        if (s !== undefined) this.render(s);
      }
      protected render(s: Readonly<UiState>): void {
        if (this.#view !== undefined) return this.#view(s);
        if (this.hidden || this.#loading) return;
        this.#loading = true;
        void import('./stats-view.js').then(({ mountStats }) => {
          const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
          this.#view = mountStats(this, root, { T, glass, glassFallback, icon, Copy, X, formatBitrate, formatMs, formatSeconds, escapeHtml });
          const now = this.ui?.getState();
          if (now !== undefined) this.#view(now);
        });
      }
    };
  });

/** `M1_ELEMENTS.PlayButton` element class. */
export const otterPlayButton = (): Ctor => playButtonClass();
/** `M1_ELEMENTS.MuteButton` element class. */
export const otterMuteButton = (): Ctor => muteButtonClass();
/** `M2_ELEMENTS.CaptionsButton` element class. */
export const otterCaptionsButton = (): Ctor => captionsButtonClass();
/** `M2_ELEMENTS.FullscreenButton` element class. */
export const otterFullscreenButton = (): Ctor => fullscreenButtonClass();
/** `M2_ELEMENTS.PipButton` element class. */
export const otterPipButton = (): Ctor => pipButtonClass();
/** `M1_ELEMENTS.TimeDisplay` element class. */
export const otterTimeDisplay = (): Ctor => timeDisplayClass();
/** `M1_ELEMENTS.TimeSlider` element class. */
export const otterTimeSlider = (): Ctor => timeSliderClass();
/** `M2_ELEMENTS.VolumeSlider` element class. */
export const otterVolumeSlider = (): Ctor => volumeSliderClass();
/** `M2_ELEMENTS.LiveIndicator` element class. */
export const otterLiveIndicator = (): Ctor => liveIndicatorClass();
/** `M2_ELEMENTS.Tooltip` element class. */
export const otterTooltip = (): Ctor => tooltipClass();
/** `M2_ELEMENTS.Gesture` element class. */
export const otterGesture = (): Ctor => gestureClass();
/** `M2_ELEMENTS.Poster` element class. */
export const otterPoster = (): Ctor => posterClass();
/** `M2_ELEMENTS.Spinner` element class. */
export const otterSpinner = (): Ctor => spinnerClass();
/** `M2_ELEMENTS.Announcer` element class. */
export const otterAnnouncer = (): Ctor => announcerClass();
/** `M2_ELEMENTS.MenuItem` element class. */
export const otterMenuItem = (): Ctor => menuItemClass();
/** `M2_ELEMENTS.Menu` element class. */
export const otterMenu = (): Ctor => menuClass();
/** `M2_ELEMENTS.SettingsMenu` element class. */
export const otterSettingsMenu = (): Ctor => settingsMenuClass();
/** `M1_ELEMENTS.Stats` element class. */
export const otterStats = (): Ctor => statsClass();
/** `M25_ELEMENTS.QualityMenu` element class. */
export const otterQualityMenu = (): Ctor => qualityMenuClass();
/** `M25_ELEMENTS.SpeedMenu` element class. */
export const otterSpeedMenu = (): Ctor => speedMenuClass();
/** `M25_ELEMENTS.SeekButton` element class. */
export const otterSeekButton = (): Ctor => seekButtonClass();
/** `M25_ELEMENTS.BigPlay` element class. */
export const otterBigPlay = (): Ctor => bigPlayClass();
/** `M25_ELEMENTS.Feedback` element class. */
export const otterFeedback = (): Ctor => feedbackClass();
/** `M25_ELEMENTS.ErrorCard` element class. */
export const otterErrorCard = (): Ctor => errorCardClass();
/** `M3_ELEMENTS.TheaterButton` element class. */
export const otterTheaterButton = (): Ctor => theaterButtonClass();
/** `M3_ELEMENTS.CastButton` element class. */
export const otterCastButton = (): Ctor => remoteButtonClass('cast');
/** `M3_ELEMENTS.AirPlayButton` element class. */
export const otterAirPlayButton = (): Ctor => remoteButtonClass('airplay');
/** `M3_ELEMENTS.MiniClose` element class. */
export const otterMiniClose = (): Ctor => miniCloseClass();

/** Registers the given elements (tag -> factory) once per registry; returns the constructors. */
export function defineElements(elements: Readonly<Record<string, () => Ctor>>, options: DefineOptions = {}): Record<string, Ctor> {
  const registry = options.registry ?? customElements;
  const defined: Record<string, Ctor> = {};
  for (const [tag, make] of Object.entries(elements)) {
    const existing = registry.get(tag);
    const ctor = existing ?? make();
    if (existing === undefined) registry.define(tag, ctor);
    defined[tag] = ctor;
  }
  return defined;
}

/** Defines every element once per registry. Returns the constructors by tag name. */
export function defineOtterElements(options: DefineOptions = {}): Record<string, Ctor> {
  return defineElements(
    {
      [M1_ELEMENTS.PlayButton]: otterPlayButton,
      [M1_ELEMENTS.MuteButton]: otterMuteButton,
      [M2_ELEMENTS.CaptionsButton]: otterCaptionsButton,
      [M2_ELEMENTS.FullscreenButton]: otterFullscreenButton,
      [M2_ELEMENTS.PipButton]: otterPipButton,
      [M1_ELEMENTS.TimeDisplay]: otterTimeDisplay,
      [M1_ELEMENTS.TimeSlider]: otterTimeSlider,
      [M2_ELEMENTS.VolumeSlider]: otterVolumeSlider,
      [M2_ELEMENTS.LiveIndicator]: otterLiveIndicator,
      [M2_ELEMENTS.Tooltip]: otterTooltip,
      [M2_ELEMENTS.Gesture]: otterGesture,
      [M2_ELEMENTS.Poster]: otterPoster,
      [M2_ELEMENTS.Spinner]: otterSpinner,
      [M2_ELEMENTS.Announcer]: otterAnnouncer,
      [M2_ELEMENTS.MenuItem]: otterMenuItem,
      [M2_ELEMENTS.Menu]: otterMenu,
      [M2_ELEMENTS.SettingsMenu]: otterSettingsMenu,
      [M1_ELEMENTS.Stats]: otterStats,
      [M25_ELEMENTS.QualityMenu]: otterQualityMenu,
      [M25_ELEMENTS.SpeedMenu]: otterSpeedMenu,
      [M25_ELEMENTS.SeekButton]: otterSeekButton,
      [M25_ELEMENTS.BigPlay]: otterBigPlay,
      [M25_ELEMENTS.Feedback]: otterFeedback,
      [M25_ELEMENTS.ErrorCard]: otterErrorCard,
      [M3_ELEMENTS.TheaterButton]: otterTheaterButton,
      [M3_ELEMENTS.CastButton]: otterCastButton,
      [M3_ELEMENTS.AirPlayButton]: otterAirPlayButton,
      [M3_ELEMENTS.MiniClose]: otterMiniClose,
    },
    options,
  );
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
