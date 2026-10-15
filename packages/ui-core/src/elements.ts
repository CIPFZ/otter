// M1 primitives (SPEC §14.1) and the stats panel (§14.2 "Stats for nerds"). Each element binds a
// slice of store state to its shadow DOM and dispatches actions; none touches the engine or the
// <video> (SPEC §3 rule 1). Clicks dispatch synchronously, so play keeps its user activation.
//
// Classes are created inside defineOtterElements(), not at module top level: `extends HTMLElement`
// at top level would throw in Workers / SSR and is a top-level side effect (AGENT §4).

import type { Unsubscribe } from '@otter-player/core';
import { findStore, type StoreConsumer, type UiState, type UiStore } from './context.js';
import { formatBitrate, formatMs, formatSeconds, formatTime, speakTime } from './format.js';

export const M1_ELEMENTS = {
  PlayButton: 'otter-play-button',
  MuteButton: 'otter-mute-button',
  TimeDisplay: 'otter-time-display',
  TimeSlider: 'otter-time-slider',
  Stats: 'otter-stats',
} as const;

const BUTTON_CSS = `
:host { display: inline-flex; }
button {
  all: unset; box-sizing: border-box; cursor: pointer;
  min-width: var(--otter-control-size, 44px); min-height: var(--otter-control-size, 44px);
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--otter-fg, #fff); border-radius: var(--otter-radius, 8px);
  font: var(--otter-font, 600 14px/1 system-ui, sans-serif);
}
button:focus-visible { outline: 3px solid var(--otter-accent, #1ee9e6); outline-offset: 2px; }
button:disabled { opacity: 0.5; cursor: default; }
svg { width: 24px; height: 24px; fill: currentColor; }
`;

const ICON = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
  volume: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>',
  muted: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/>',
} as const;

const svg = (path: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;

/** Shared lifecycle: find the store, subscribe while connected, render on every state change. */
function createBase(): abstract new () => HTMLElement & StoreConsumer & { readonly store: UiStore | undefined } {
  abstract class OtterElement extends HTMLElement implements StoreConsumer {
    #store: UiStore | undefined;
    #off: Unsubscribe | undefined;
    get store(): UiStore | undefined {
      return this.#store;
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
      this.#off = store.subscribe((s) => this.render(s));
      this.render(store.getState());
    }
    protected abstract setup(): void;
    protected abstract render(state: Readonly<UiState>): void;
  }
  return OtterElement;
}

export interface DefineOptions {
  readonly registry?: CustomElementRegistry;
}

/** Defines the M1 elements once per registry. Returns the constructors by tag name. */
export function defineOtterElements(options: DefineOptions = {}): Record<string, CustomElementConstructor> {
  const registry = options.registry ?? customElements;
  const Base = createBase();

  class PlayButton extends Base {
    #button: HTMLButtonElement | undefined;
    protected setup(): void {
      if (this.#button !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${BUTTON_CSS}</style><button part="button" type="button" aria-label="Play">${svg(ICON.play)}</button>`;
      this.#button = root.querySelector('button') as HTMLButtonElement;
      this.#button.addEventListener('click', (e) => this.store?.dispatch('toggle-paused', {}, { type: e.type, source: 'otter-play-button' }));
    }
    protected render(s: Readonly<UiState>): void {
      const b = this.#button;
      if (b === undefined) return;
      const playing = !s.paused;
      const label = playing ? 'Pause' : 'Play';
      if (b.getAttribute('aria-label') !== label) {
        b.setAttribute('aria-label', label);
        b.innerHTML = svg(playing ? ICON.pause : ICON.play);
      }
      b.disabled = s.status !== 'ready';
      this.toggleAttribute('paused', !playing);
    }
  }

  class MuteButton extends Base {
    #button: HTMLButtonElement | undefined;
    protected setup(): void {
      if (this.#button !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>${BUTTON_CSS}</style><button part="button" type="button" aria-label="Mute">${svg(ICON.volume)}</button>`;
      this.#button = root.querySelector('button') as HTMLButtonElement;
      this.#button.addEventListener('click', (e) => this.store?.dispatch('toggle-muted', {}, { type: e.type, source: 'otter-mute-button' }));
    }
    protected render(s: Readonly<UiState>): void {
      const b = this.#button;
      if (b === undefined) return;
      const muted = s.muted || s.volume === 0;
      const label = muted ? 'Unmute' : 'Mute';
      if (b.getAttribute('aria-label') !== label) {
        b.setAttribute('aria-label', label);
        b.innerHTML = svg(muted ? ICON.muted : ICON.volume);
      }
      this.toggleAttribute('muted', muted);
    }
  }

  class TimeDisplay extends Base {
    #text: HTMLElement | undefined;
    protected setup(): void {
      if (this.#text !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>:host{display:inline-flex;align-items:center;color:var(--otter-fg,#fff);font:var(--otter-font-mono,500 13px/1 ui-monospace,monospace);font-variant-numeric:tabular-nums}</style><span part="text"></span>`;
      this.#text = root.querySelector('span') as HTMLElement;
    }
    protected render(s: Readonly<UiState>): void {
      const t = this.#text;
      if (t === undefined) return;
      const text = s.live ? 'LIVE' : `${formatTime(s.currentTime)} / ${formatTime(s.duration)}`;
      if (t.textContent !== text) t.textContent = text;
    }
  }

  class TimeSlider extends Base {
    #input: HTMLInputElement | undefined;
    #dragging = false;
    protected setup(): void {
      if (this.#input !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
:host { display: flex; align-items: center; flex: 1; min-width: 80px; }
input { width: 100%; margin: 0; height: var(--otter-control-size, 44px); background: transparent; accent-color: var(--otter-accent, #1ee9e6); cursor: pointer; }
input:focus-visible { outline: 3px solid var(--otter-accent, #1ee9e6); outline-offset: 2px; }
</style><input part="range" type="range" min="0" max="0" step="0.1" value="0" aria-label="Seek">`;
      const input = root.querySelector('input') as HTMLInputElement;
      this.#input = input;
      input.addEventListener('input', () => {
        this.#dragging = true;
        input.setAttribute('aria-valuetext', `${speakTime(Number(input.value))} of ${speakTime(Number(input.max))}`);
      });
      input.addEventListener('change', (e) => {
        this.#dragging = false;
        this.store?.dispatch('seek', { time: Number(input.value) }, { type: e.type, source: 'otter-time-slider' });
      });
    }
    protected render(s: Readonly<UiState>): void {
      const input = this.#input;
      if (input === undefined) return;
      const seekable = Number.isFinite(s.duration) && s.duration > 0 && !s.live;
      input.disabled = !seekable;
      if (!seekable) return;
      if (input.max !== String(s.duration)) input.max = String(s.duration);
      if (!this.#dragging) {
        input.value = String(s.currentTime);
        input.setAttribute('aria-valuetext', `${speakTime(s.currentTime)} of ${speakTime(s.duration)}`);
      }
      this.style.setProperty('--otter-buffered', `${Math.min(100, (s.bufferedEnd / s.duration) * 100)}%`);
    }
  }

  class Stats extends Base {
    #list: HTMLElement | undefined;
    #route: HTMLElement | undefined;
    protected setup(): void {
      if (this.#list !== undefined) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
:host { display: block; color: var(--otter-fg, #fff); background: color-mix(in srgb, var(--otter-bg, #243447) 88%, transparent);
  font: var(--otter-font-mono, 12px/1.5 ui-monospace, monospace); padding: 8px 12px; border-radius: var(--otter-radius, 8px); max-width: 100%; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0 12px; margin: 0; }
dt { opacity: 0.75; } dd { margin: 0; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; margin: 4px 0 0; max-height: 12em; overflow: auto; }
summary { cursor: pointer; } summary:focus-visible { outline: 3px solid var(--otter-accent, #1ee9e6); }
</style><section part="panel" aria-label="Playback statistics"><dl part="list"></dl>
<details part="route"><summary>Route (router.explain)</summary><pre></pre></details></section>`;
      this.#list = root.querySelector('dl') as HTMLElement;
      this.#route = root.querySelector('pre') as HTMLElement;
    }
    protected render(s: Readonly<UiState>): void {
      const list = this.#list;
      const route = this.#route;
      if (list === undefined || route === undefined) return;
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
