// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, createStore } from '@otter-player/core';
import { MEDIA_SLICE, type MediaActionMap, type MediaState } from '@otter-player/media';
import { INITIAL_PRESENTATION_STATE, PRESENTATION_SLICE } from '@otter-player/presentation';
import { TEXT_SLICE } from '@otter-player/text';
import {
  CHROME_SLICE,
  createChromePlugin,
  defineOtterElements,
  provideStore,
  provideStrings,
  settingsGroups,
  STRINGS_EN,
  STRINGS_ZH,
  type ChromeActionMap,
  type ChromeState,
  type UiActions,
  type UiState,
} from '@otter-player/ui-core';

defineOtterElements();

function mount(html: string, lang?: string) {
  const store = createStore<UiState, UiActions>({ slices: [MEDIA_SLICE, TEXT_SLICE, CHROME_SLICE, PRESENTATION_SLICE] });
  const calls: [string, unknown][] = [];
  for (const type of [
    'toggle-captions',
    'toggle-fullscreen',
    'toggle-pip',
    'set-volume',
    'set-muted',
    'select-quality',
    'set-playback-rate',
    'select-text-track',
    'select-audio-track',
    'set-caption-style',
    'toggle-theater',
    'open-cast-picker',
    'open-airplay-picker',
  ] as const) {
    store.handle(type, (payload) => void calls.push([type, payload]));
  }
  store.handle('open-menu', ({ id }) => store.setState({ menu: id }));
  const root = document.createElement('div');
  if (lang !== undefined) root.setAttribute('lang', lang);
  root.innerHTML = html;
  document.body.replaceChildren(root);
  provideStore(root, store.view());
  const shadow = (tag: string): ShadowRoot => (root.querySelector(tag) as HTMLElement).shadowRoot as ShadowRoot;
  return { store, root, calls, shadow };
}

const READY: Partial<UiState> = {
  status: 'ready',
  activeQuality: 'v720',
  tracks: {
    video: [
      { kind: 'video', id: 'v360', selected: false, height: 360, bitrate: 800_000 },
      { kind: 'video', id: 'v720', selected: true, height: 720, bitrate: 2_500_000 },
    ],
    audio: [],
    text: [],
    quality: 'selectable',
    requestedQuality: 'auto',
  },
  textTracks: [{ id: 'sidecar:0', source: 'sidecar', role: 'subtitles', format: 'vtt', language: 'en', label: 'English' }],
};

describe('M2 primitives', () => {
  it('captions, fullscreen and PiP buttons: names, pressed state, unsupported hiding', () => {
    const { store, calls, shadow, root } = mount('<otter-captions-button></otter-captions-button><otter-fullscreen-button></otter-fullscreen-button><otter-pip-button></otter-pip-button>');
    const cc = shadow('otter-captions-button').querySelector('button') as HTMLButtonElement;
    expect(root.querySelector('otter-captions-button')?.hasAttribute('data-otter-unsupported')).toBe(true);
    store.setState({ ...READY, presentation: { ...INITIAL_PRESENTATION_STATE.presentation, capabilities: { ...INITIAL_PRESENTATION_STATE.presentation.capabilities, fullscreen: 'native' } } });
    expect(root.querySelector('otter-captions-button')?.hasAttribute('data-otter-unsupported')).toBe(false);
    expect(cc.getAttribute('aria-label')).toBe('Captions');
    expect(cc.getAttribute('aria-pressed')).toBe('false');
    cc.click();
    store.setState({ textTrack: 'sidecar:0' });
    expect(cc.getAttribute('aria-pressed')).toBe('true');
    const fs = shadow('otter-fullscreen-button').querySelector('button') as HTMLButtonElement;
    fs.click();
    store.setState({ presentation: { ...(store.getState().presentation ?? INITIAL_PRESENTATION_STATE.presentation), mode: 'fullscreen' } });
    expect(fs.getAttribute('aria-label')).toBe('Exit fullscreen');
    // No PiP support: the button is hidden, not just disabled.
    expect(root.querySelector('otter-pip-button')?.hasAttribute('data-otter-unsupported')).toBe(true);
    expect(calls).toEqual([
      ['toggle-captions', {}],
      ['toggle-fullscreen', {}],
    ]);
  });

  it('theater, Cast and AirPlay buttons: shown by capability / availability, dispatch synchronously', () => {
    const { store, calls, shadow, root } = mount('<otter-theater-button></otter-theater-button><otter-cast-button></otter-cast-button><otter-airplay-button></otter-airplay-button>');
    const caps = { ...INITIAL_PRESENTATION_STATE.presentation.capabilities, theater: 'emulated' as const };
    store.setState({ presentation: { ...INITIAL_PRESENTATION_STATE.presentation, capabilities: caps } });
    expect(root.querySelector('otter-theater-button')?.hasAttribute('data-otter-unsupported')).toBe(false);
    expect(root.querySelector('otter-cast-button')?.hasAttribute('data-otter-unsupported')).toBe(true);
    expect(root.querySelector('otter-airplay-button')?.hasAttribute('data-otter-unsupported')).toBe(true);
    const theater = shadow('otter-theater-button').querySelector('button') as HTMLButtonElement;
    theater.click();
    store.setState({ presentation: { ...INITIAL_PRESENTATION_STATE.presentation, capabilities: caps, mode: 'theater' } });
    expect(theater.getAttribute('aria-pressed')).toBe('true');
    expect(theater.getAttribute('aria-label')).toBe('Default view');
    store.setState({ cast: 'available', airplay: 'available' });
    const cast = shadow('otter-cast-button').querySelector('button') as HTMLButtonElement;
    expect(root.querySelector('otter-cast-button')?.hasAttribute('data-otter-unsupported')).toBe(false);
    cast.click();
    store.setState({ cast: 'connected' });
    expect(cast.getAttribute('aria-pressed')).toBe('true');
    (shadow('otter-airplay-button').querySelector('button') as HTMLButtonElement).click();
    expect(calls).toEqual([
      ['toggle-theater', {}],
      ['open-cast-picker', {}],
      ['open-airplay-picker', {}],
    ]);
  });

  it('volume slider sets volume, unmutes when raised and speaks percent', () => {
    const { store, calls, shadow } = mount('<otter-volume-slider></otter-volume-slider>');
    const input = shadow('otter-volume-slider').querySelector('input') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Volume');
    store.setState({ volume: 0.5 });
    expect(input.getAttribute('aria-valuetext')).toBe('50%');
    store.setState({ muted: true });
    expect(input.value).toBe('0');
    input.value = '0.3';
    input.dispatchEvent(new Event('input'));
    expect(calls).toEqual([
      ['set-volume', { volume: 0.3 }],
      ['set-muted', { muted: false }],
    ]);
  });

  it('strings follow the closest lang, or a provided table', () => {
    const zh = mount('<otter-play-button></otter-play-button>', 'zh-CN');
    zh.store.setState({ status: 'ready' });
    expect(zh.shadow('otter-play-button').querySelector('button')?.getAttribute('aria-label')).toBe(STRINGS_ZH.play);
    const custom = mount('<otter-play-button></otter-play-button>');
    provideStrings(custom.root, { ...STRINGS_EN, play: 'Lecture' });
    custom.store.setState({ status: 'ready', currentTime: 1 });
    expect(custom.shadow('otter-play-button').querySelector('button')?.getAttribute('aria-label')).toBe('Lecture');
  });

  it('spinner shows after 800 ms of loading or rebuffering; poster until playback starts', async () => {
    vi.useFakeTimers();
    const { store, root } = mount('<otter-spinner></otter-spinner><otter-poster src="/p.jpg"></otter-poster>');
    const spinner = root.querySelector('otter-spinner') as HTMLElement;
    const poster = root.querySelector('otter-poster') as HTMLElement;
    store.setState({ status: 'loading' });
    // No flicker for short loads.
    await vi.advanceTimersByTimeAsync(700);
    expect(spinner.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(spinner.hidden).toBe(false);
    expect(spinner.shadowRoot?.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('Loading');
    store.setState({ status: 'ready' });
    expect(spinner.hidden).toBe(true);
    expect(poster.hidden).toBe(false);
    expect(poster.getAttribute('aria-hidden')).toBe('true');
    store.setState({ paused: false, waiting: true, readyState: 2 });
    await vi.advanceTimersByTimeAsync(900);
    expect(spinner.hidden).toBe(false);
    expect(poster.hidden).toBe(true);
    vi.useRealTimers();
  });

  it('big play shows in the poster state only; error card offers a retry of the source', async () => {
    const { store, calls, root } = mount('<otter-big-play></otter-big-play><otter-error></otter-error>');
    store.handle('load', (p) => void calls.push(['load', p]));
    const big = root.querySelector('otter-big-play') as HTMLElement;
    const err = root.querySelector('otter-error') as HTMLElement;
    store.setState({ status: 'ready', paused: true, currentTime: 0 });
    expect(big.hidden).toBe(false);
    store.setState({ paused: false });
    expect(big.hidden).toBe(true);
    expect(err.hidden).toBe(true);
    store.setState({ status: 'error', source: { src: '/a.m3u8' }, error: { type: 'network', details: 'manifestLoadError', fatal: true, recoverable: false } });
    expect(err.hidden).toBe(false);
    // The card's view loads with the first error.
    await vi.waitFor(() => expect(err.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain('manifestLoadError'));
    (err.shadowRoot?.querySelector('button') as HTMLButtonElement).click();
    expect(calls.at(-1)).toEqual(['load', { source: { src: '/a.m3u8' }, options: { autoplay: true } }]);
  });

  it('live indicator only for live, marks being behind the edge', async () => {
    const { store, root } = mount('<otter-live-indicator></otter-live-indicator>');
    const el = root.querySelector('otter-live-indicator') as HTMLElement;
    expect(el.hasAttribute('data-otter-unsupported')).toBe(true);
    store.setState({ live: true, latency: 3 });
    expect(el.hasAttribute('data-otter-unsupported')).toBe(false);
    // The view loads once the source is live.
    // "Live" with how far behind the edge (ADR-011 §2), the seconds visual only.
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('[part="badge"] b')?.textContent).toBe('Live'));
    expect(el.shadowRoot?.querySelector('[part="badge"] [part="behind"]')?.textContent).toBe('−3.0 s');
    expect(el.shadowRoot?.querySelector('[part="behind"]')?.getAttribute('aria-hidden')).toBe('true');
    store.setState({ latency: 30 });
    await vi.waitFor(() => expect(el.hasAttribute('behind')).toBe(true));
    // "Behind" counts from the engine's target: 7 s behind a 6 s HOLD-BACK is at the target.
    store.setState({ latency: 7, targetLatency: 6 });
    await vi.waitFor(() => expect(el.hasAttribute('behind')).toBe(false));
  });

  it('behind the live edge the badge becomes a "Back to live" button: seek-to-live, then play', async () => {
    const { store, root } = mount('<otter-live-indicator></otter-live-indicator>');
    const got: string[] = [];
    store.handle('seek-to-live', () => void got.push('seek-to-live'));
    store.handle('play', () => void got.push('play'));
    const el = root.querySelector('otter-live-indicator') as HTMLElement;
    store.setState({ live: true, latency: 1, paused: false });
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector('button')).toBeTruthy());
    const button = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    await vi.waitFor(() => expect(button.hidden).toBe(true));
    store.setState({ latency: 12, paused: true });
    await vi.waitFor(() => expect(button.hidden).toBe(false));
    expect(button.querySelector('span')?.textContent).toBe('Back to live');
    expect(button.querySelector('[part="behind"]')?.textContent).toBe('−12.0 s');
    button.click();
    expect(got).toEqual(['seek-to-live', 'play']);
  });

  it('gesture layer dims with brightness; slider shows the swipe seek preview', () => {
    const { store, shadow } = mount('<otter-gesture></otter-gesture><otter-time-slider></otter-time-slider>');
    store.setState({ brightness: 0.6, duration: 100, currentTime: 40 });
    expect((shadow('otter-gesture').querySelector('.dim') as HTMLElement).style.opacity).toBe('0.4');
    store.setState({ seekPreview: 15 });
    const card = shadow('otter-time-slider').querySelector('.card') as HTMLElement;
    expect(card.hasAttribute('data-show')).toBe(true);
    expect(card.querySelector('.time')?.textContent).toBe('+0:15 · 0:55');
    store.setState({ seekPreview: null });
    expect(card.hasAttribute('data-show')).toBe(false);
  });

  it('progress bar: played / buffered layers, arrows step 5 s (Shift 10 s)', () => {
    const { store, calls, shadow } = mount('<otter-time-slider></otter-time-slider>');
    store.handle('seek', (p) => void calls.push(['seek', p]));
    store.setState({ status: 'ready', duration: 100, currentTime: 40, bufferedEnd: 60 });
    const host = shadow('otter-time-slider').host as HTMLElement;
    expect(host.style.getPropertyValue('--otter-played')).toBe('40%');
    expect(host.style.getPropertyValue('--otter-buffered')).toBe('60%');
    const input = shadow('otter-time-slider').querySelector('input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }));
    expect(calls).toEqual([
      ['seek', { time: 45 }],
      ['seek', { time: 30 }],
    ]);
  });
});

describe('announcer', () => {
  afterEach(() => vi.useRealTimers());

  it('announces user-relevant changes politely', async () => {
    vi.useFakeTimers();
    const { store, shadow } = mount('<otter-announcer></otter-announcer>');
    const region = shadow('otter-announcer').querySelector('[aria-live="polite"]') as HTMLElement;
    const said = async (): Promise<string> => {
      await vi.advanceTimersByTimeAsync(500);
      return region.textContent ?? '';
    };
    store.setState({ status: 'ready', ...READY });
    store.setState({ paused: false });
    expect(await said()).toBe('Playing');
    store.setState({ muted: true });
    expect(await said()).toBe('Muted');
    store.setState({ textTrack: 'sidecar:0' });
    expect(await said()).toBe('Captions on: English');
    store.setState({ quality: 'v360' });
    expect(await said()).toBe('Quality 360P');
    store.setState({ muted: false, volume: 0.4 });
    store.setState({ volume: 0.6 });
    expect(await said()).toBe('Volume 60%');
  });
});

describe('settings menu (APG menu button, two levels)', () => {
  it('groups quality (Auto shows the playing rendition), speed, captions; caption style comes with level two', async () => {
    const state = { ...(MEDIA_SLICE.initialState as UiState), ...READY } as UiState;
    const groups = settingsGroups(state, STRINGS_EN);
    expect(groups.map((g) => g.id)).toEqual(['quality', 'speed', 'captions']);
    const { captionStyleGroups } = await import('../src/settings-level.js');
    expect(captionStyleGroups(state, STRINGS_EN).map((g) => g.id)).toEqual(['caption-size', 'caption-color', 'caption-background', 'caption-window', 'caption-edge', 'caption-font']);
    expect(groups[0]?.options.map((o) => `${o.label}${o.checked ? '*' : ''}`)).toEqual(['Auto (720P)*', '720P', '360P']);
    expect(groups[0]?.options[1]?.detail).toBe('2.5 Mbps');
    expect(groups[1]?.options.find((o) => o.checked)?.label).toBe('Normal');
    expect(groups[2]?.options.map((o) => o.label)).toEqual(['Off', 'English']);
  });

  function open() {
    const m = mount('<otter-settings-menu></otter-settings-menu>');
    m.store.setState({ ...READY });
    const sr = m.shadow('otter-settings-menu');
    const trigger = sr.querySelector('button') as HTMLButtonElement;
    const focused = (): HTMLElement => sr.activeElement as HTMLElement;
    const key = (k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true, ...init });
      focused().dispatchEvent(e);
      return e;
    };
    return { ...m, sr, trigger, focused, key, menu: sr.querySelector('[role="menu"]') as HTMLElement };
  }

  /** Level two is an on-demand chunk the menu requests when it opens. */
  const levelsLoaded = async (): Promise<void> => {
    await import('../src/settings-level.js');
    await new Promise((r) => setTimeout(r, 0));
  };

  it('level one: value rows, speed segments, focus starts at the checked speed', async () => {
    const { trigger, focused, key, menu, store, sr } = open();
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-label')).toBe('Settings');
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(store.getState().menu).not.toBeNull();
    const rows = () => [...sr.querySelectorAll<HTMLElement>('[role="menuitem"][aria-haspopup="menu"]')].map((r) => r.getAttribute('aria-label'));
    // The Picture row comes with the level-two chunk (requested when the menu opens).
    await vi.waitFor(() => expect(rows()).toEqual(['Quality, Auto (720P)', 'Captions, Off', 'Caption style, Default', 'Picture, Original picture']));
    // The checked speed segment is the first checked item.
    expect(focused().getAttribute('aria-label')).toBe('Normal');
    key('ArrowRight');
    expect(focused().getAttribute('aria-label')).toBe('1.25x');
    key('Home');
    expect(focused().getAttribute('aria-label')).toBe('Quality, Auto (720P)');
  });

  it('opens a level with Enter / ArrowRight, chooses, returns to the row; ArrowLeft goes back', async () => {
    const { trigger, focused, key, calls, menu, sr } = open();
    trigger.click();
    await levelsLoaded();
    key('Home');
    key('Enter');
    // Level two: back row + options, focus on the checked option.
    expect(sr.querySelector('.back')?.getAttribute('aria-label')).toBe('Back: Quality');
    expect(focused().textContent).toBe('Auto (720P)');
    key('ArrowDown');
    key('Enter');
    expect(calls.at(-1)).toEqual(['select-quality', { id: 'v720' }]);
    // Back on level one, on the quality row; the menu stays open.
    expect(menu.hidden).toBe(false);
    expect(focused().dataset['key']).toBe('row:quality');
    key('ArrowRight');
    expect(sr.querySelector('.back')).not.toBeNull();
    key('ArrowLeft');
    expect(sr.querySelector('.back')).toBeNull();
    expect(focused().dataset['key']).toBe('row:quality');
    // Esc closes the whole menu and returns focus to the trigger, without leaving fullscreen.
    const esc = key('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(sr.activeElement).toBe(trigger);
  });

  it('speed segments and caption style (CVAA) dispatch without leaving their view; audio level with several tracks', async () => {
    const { store, calls, trigger, sr } = open();
    store.setState({
      captionStyle: { scale: 2 },
      tracks: { ...(READY.tracks as UiState['tracks']), audio: [{ kind: 'audio', id: 'audio-0', selected: true, language: 'en' }, { kind: 'audio', id: 'audio-1', selected: false, language: 'en', label: 'Audio description' }] },
    });
    trigger.click();
    await levelsLoaded();
    (sr.querySelector('[data-key="speed:1.5"]') as HTMLElement).click();
    expect(calls.at(-1)).toEqual(['set-playback-rate', { rate: 1.5 }]);
    expect(sr.querySelector('.back')).toBeNull();
    (sr.querySelector('[data-key="row:caption-style"]') as HTMLElement).click();
    expect(sr.querySelector('.preview')).not.toBeNull();
    expect(sr.querySelector('[data-group="caption-size"] [aria-checked="true"]')?.textContent).toBe('200%');
    [...sr.querySelectorAll<HTMLElement>('[data-group="caption-color"] [role="menuitemradio"]')].find((i) => i.textContent === 'Yellow')?.click();
    expect(calls.at(-1)).toEqual(['set-caption-style', { color: '#ffff00' }]);
    expect(sr.querySelector('.preview')).not.toBeNull();
    (sr.querySelector('.back') as HTMLElement).click();
    (sr.querySelector('[data-key="row:audio"]') as HTMLElement).click();
    [...sr.querySelectorAll<HTMLElement>('[data-group="audio"] [role="menuitemradio"]')].find((i) => i.textContent === 'Audio description')?.click();
    expect(calls.at(-1)).toEqual(['select-audio-track', { id: 'audio-1' }]);
  });

  it('roles: rows are menuitem with aria-haspopup, options menuitemradio with aria-checked, groups are labelled', async () => {
    const { trigger, sr } = open();
    trigger.click();
    await levelsLoaded();
    for (const g of sr.querySelectorAll('[role="group"]')) {
      const label = g.getAttribute('aria-label') ?? sr.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent ?? '';
      expect(label).not.toBe('');
    }
    for (const item of sr.querySelectorAll('[role="menuitemradio"]')) expect(['true', 'false']).toContain(item.getAttribute('aria-checked'));
    (sr.querySelector('[data-key="row:captions"]') as HTMLElement).click();
    const options = [...sr.querySelectorAll('[role="menuitemradio"]')].map((i) => `${i.textContent}:${i.getAttribute('aria-checked')}`);
    expect(options).toEqual(['Off:true', 'English:false']);
  });

  it('hovering the settings button prefetches level two: its rows are there on open', async () => {
    const m = mount('<div data-otter-player><otter-stats hidden></otter-stats><otter-settings-menu></otter-settings-menu></div>');
    m.store.setState({ ...READY });
    const menu = m.root.querySelector('otter-settings-menu') as HTMLElement;
    menu.dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise((r) => setTimeout(r, 50));
    const sr = m.shadow('otter-settings-menu');
    (sr.querySelector('button') as HTMLButtonElement).click();
    // Synchronously on open: no wait for the chunk.
    expect(sr.querySelector('[role="menuitemcheckbox"]')).toBeTruthy();
    expect([...sr.querySelectorAll('[role="menuitem"]')].some((r) => r.getAttribute('aria-label')?.startsWith('Picture,'))).toBe(true);
  });

  it('stats switch toggles the player stats panel', async () => {
    const m = mount('<div data-otter-player><otter-stats hidden></otter-stats><otter-settings-menu></otter-settings-menu></div>');
    m.store.setState({ ...READY });
    const sr = m.shadow('otter-settings-menu');
    (sr.querySelector('button') as HTMLButtonElement).click();
    // The switch comes with the level-two chunk.
    await vi.waitFor(() => expect(sr.querySelector('[role="menuitemcheckbox"]')).toBeTruthy());
    const sw = sr.querySelector('[role="menuitemcheckbox"]') as HTMLElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.click();
    expect((m.root.querySelector('otter-stats') as HTMLElement).hidden).toBe(false);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });
});

describe('text menus (quality / speed buttons)', () => {
  it('show the current value as text and choose from one list', () => {
    const { store, calls, shadow } = mount('<otter-quality-menu></otter-quality-menu><otter-speed-menu></otter-speed-menu>');
    store.setState({ ...READY });
    const q = shadow('otter-quality-menu').querySelector('button') as HTMLButtonElement;
    expect(q.textContent).toBe('720P');
    expect(q.getAttribute('aria-label')).toBe('Quality: 720P');
    q.click();
    (shadow('otter-quality-menu').querySelector('[value="v360"]') as HTMLElement).click();
    expect(calls.at(-1)).toEqual(['select-quality', { id: 'v360' }]);
    const sp = shadow('otter-speed-menu').querySelector('button') as HTMLButtonElement;
    expect(sp.textContent).toBe('1.0x');
    store.setState({ playbackRate: 1.25 });
    expect(sp.textContent).toBe('1.25x');
  });
});

describe('chrome plugin', () => {
  afterEach(() => vi.useRealTimers());

  it('auto-hides the controls while playing and idle, never while paused or a menu is open', async () => {
    vi.useFakeTimers();
    const core = createCore<MediaState & ChromeState, ChromeActionMap & MediaActionMap>({ slices: [MEDIA_SLICE, CHROME_SLICE], plugins: [createChromePlugin({ idleMs: 1000 })] });
    await core.start();
    const s = core.store;
    s.setState({ status: 'ready', paused: false });
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.getState().controlsVisible).toBe(false);
    s.dispatch('show-controls', {});
    expect(s.getState().controlsVisible).toBe(true);
    s.dispatch('open-menu', { id: 'm' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.getState().controlsVisible).toBe(true);
    s.dispatch('escape', {});
    expect(s.getState().menu).toBeNull();
    s.setState({ paused: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.getState().controlsVisible).toBe(true);
    s.dispatch('toggle-controls', {});
    expect(s.getState().controlsVisible).toBe(false);
  });

  it('brightness stays in range; a committed seek preview becomes seek-by', async () => {
    const seeks: number[] = [];
    const core = createCore<MediaState & ChromeState, ChromeActionMap & MediaActionMap>({ slices: [MEDIA_SLICE, CHROME_SLICE], plugins: [createChromePlugin()] });
    await core.start();
    core.store.handle('seek-by', ({ seconds }) => void seeks.push(seconds));
    core.store.dispatch('brightness-by', { delta: -2 });
    expect(core.store.getState().brightness).toBe(0.2);
    core.store.dispatch('seek-preview', { seconds: 12 });
    expect(core.store.getState().seekPreview).toBe(12);
    core.store.dispatch('seek-preview', { seconds: 12, commit: true });
    expect(core.store.getState().seekPreview).toBeNull();
    expect(seeks).toEqual([12]);
  });
});
