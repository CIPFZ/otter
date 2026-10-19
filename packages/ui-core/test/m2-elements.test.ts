// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, createStore } from '@otter-player/core';
import { MEDIA_SLICE, type MediaActionMap, type MediaState } from '@otter-player/media';
import { PRESENTATION_SLICE } from '@otter-player/presentation';
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
    store.setState({ ...READY, fullscreenAvailable: true });
    expect(root.querySelector('otter-captions-button')?.hasAttribute('data-otter-unsupported')).toBe(false);
    expect(cc.getAttribute('aria-label')).toBe('Captions');
    expect(cc.getAttribute('aria-pressed')).toBe('false');
    cc.click();
    store.setState({ textTrack: 'sidecar:0' });
    expect(cc.getAttribute('aria-pressed')).toBe('true');
    const fs = shadow('otter-fullscreen-button').querySelector('button') as HTMLButtonElement;
    fs.click();
    store.setState({ fullscreen: true });
    expect(fs.getAttribute('aria-label')).toBe('Exit fullscreen');
    // No PiP support: the button is hidden, not just disabled.
    expect(root.querySelector('otter-pip-button')?.hasAttribute('data-otter-unsupported')).toBe(true);
    expect(calls).toEqual([
      ['toggle-captions', {}],
      ['toggle-fullscreen', {}],
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

  it('spinner shows while loading or rebuffering; poster until playback starts', () => {
    const { store, root } = mount('<otter-spinner></otter-spinner><otter-poster src="/p.jpg"></otter-poster>');
    const spinner = root.querySelector('otter-spinner') as HTMLElement;
    const poster = root.querySelector('otter-poster') as HTMLElement;
    store.setState({ status: 'loading' });
    expect(spinner.hidden).toBe(false);
    expect(spinner.shadowRoot?.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('Loading');
    store.setState({ status: 'ready' });
    expect(spinner.hidden).toBe(true);
    expect(poster.hidden).toBe(false);
    expect(poster.getAttribute('aria-hidden')).toBe('true');
    store.setState({ paused: false, waiting: true, readyState: 2 });
    expect(spinner.hidden).toBe(false);
    expect(poster.hidden).toBe(true);
  });

  it('live indicator only for live, marks being behind the edge', () => {
    const { store, root } = mount('<otter-live-indicator></otter-live-indicator>');
    const el = root.querySelector('otter-live-indicator') as HTMLElement;
    expect(el.hasAttribute('data-otter-unsupported')).toBe(true);
    store.setState({ live: true, latency: 3 });
    expect(el.hasAttribute('data-otter-unsupported')).toBe(false);
    expect(el.shadowRoot?.querySelector('[part="badge"]')?.textContent).toBe('Live');
    store.setState({ latency: 30 });
    expect(el.hasAttribute('behind')).toBe(true);
  });

  it('gesture layer dims with brightness; slider shows the swipe seek preview', () => {
    const { store, shadow } = mount('<otter-gesture></otter-gesture><otter-time-slider></otter-time-slider>');
    store.setState({ brightness: 0.6, duration: 100, currentTime: 40 });
    expect((shadow('otter-gesture').querySelector('.dim') as HTMLElement).style.opacity).toBe('0.4');
    store.setState({ seekPreview: 15 });
    const preview = shadow('otter-time-slider').querySelector('.preview') as HTMLElement;
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toBe('+0:15 · 0:55');
    store.setState({ seekPreview: null });
    expect(preview.hidden).toBe(true);
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
    expect(await said()).toBe('Quality 360p');
    store.setState({ muted: false, volume: 0.4 });
    store.setState({ volume: 0.6 });
    expect(await said()).toBe('Volume 60%');
  });
});

describe('settings menu (APG menu button)', () => {
  it('groups quality (Auto shows the playing rendition), speed and captions', () => {
    const groups = settingsGroups({ ...(MEDIA_SLICE.initialState as UiState), ...READY } as UiState, STRINGS_EN);
    expect(groups.map((g) => g.id)).toEqual(['quality', 'speed', 'captions', 'caption-size', 'caption-color', 'caption-background', 'caption-edge', 'caption-font']);
    expect(groups[0]?.options.map((o) => `${o.label}${o.checked ? '*' : ''}`)).toEqual(['Auto (720p)*', '720p', '360p']);
    expect(groups[1]?.options.find((o) => o.checked)?.label).toBe('Normal');
    expect(groups[2]?.options.map((o) => o.label)).toEqual(['Off', 'English']);
  });

  it('opens on ArrowDown at the checked item, moves with arrows, chooses with Enter, Esc returns focus', () => {
    const { store, calls, shadow, root } = mount('<otter-settings-menu></otter-settings-menu>');
    store.setState({ ...READY });
    const host = root.querySelector('otter-settings-menu') as HTMLElement;
    const sr = shadow('otter-settings-menu');
    const trigger = sr.querySelector('button') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-label')).toBe('Settings');
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const menu = sr.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(store.getState().menu).not.toBeNull();
    const focused = (): HTMLElement => sr.activeElement as HTMLElement;
    expect(focused().textContent).toBe('Auto (720p)');
    const key = (k: string): KeyboardEvent => {
      const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true });
      focused().dispatchEvent(e);
      return e;
    };
    key('ArrowDown');
    expect(focused().textContent).toBe('720p');
    key('End');
    expect(focused().textContent).toBe('Casual');
    key('Home');
    key('ArrowUp');
    expect(focused().textContent).toBe('Casual');
    key('Enter');
    expect(calls).toEqual([['set-caption-style', { font: 'casual' }]]);
    expect(menu.hidden).toBe(true);
    expect(sr.activeElement).toBe(trigger);
    expect(store.getState().menu).toBeNull();

    trigger.click();
    expect(menu.hidden).toBe(false);
    const esc = key('Escape');
    // Esc stays in the menu (the player must not leave fullscreen as well).
    expect(esc.defaultPrevented).toBe(true);
    expect(menu.hidden).toBe(true);
    expect(host.isConnected).toBe(true);
  });

  it('caption style groups (CVAA) dispatch style patches; audio group appears with several tracks', () => {
    const { store, calls, shadow } = mount('<otter-settings-menu></otter-settings-menu>');
    store.setState({
      ...READY,
      captionStyle: { scale: 2 },
      tracks: { ...(READY.tracks as UiState['tracks']), audio: [{ kind: 'audio', id: 'audio-0', selected: true, language: 'en' }, { kind: 'audio', id: 'audio-1', selected: false, language: 'en', label: 'Audio description' }] },
    });
    const sr = shadow('otter-settings-menu');
    (sr.querySelector('button') as HTMLButtonElement).click();
    const ids = [...sr.querySelectorAll('[role="group"]')].map((g) => (g as HTMLElement).dataset['group']);
    expect(ids).toEqual(['quality', 'speed', 'audio', 'captions', 'caption-size', 'caption-color', 'caption-background', 'caption-edge', 'caption-font']);
    const checkedSize = sr.querySelector('[data-group="caption-size"] [aria-checked="true"]');
    expect(checkedSize?.textContent).toBe('200%');
    const yellow = [...sr.querySelectorAll<HTMLElement>('[data-group="caption-color"] [role="menuitemradio"]')].find((i) => i.textContent === 'Yellow');
    (sr.querySelector('button') as HTMLButtonElement).click();
    yellow?.click();
    expect(calls.at(-1)).toEqual(['set-caption-style', { color: '#ffff00' }]);
    (sr.querySelector('button') as HTMLButtonElement).click();
    [...sr.querySelectorAll<HTMLElement>('[data-group="audio"] [role="menuitemradio"]')].find((i) => i.textContent === 'Audio description')?.click();
    expect(calls.at(-1)).toEqual(['select-audio-track', { id: 'audio-1' }]);
  });

  it('every item is a menuitemradio with aria-checked inside a labelled group', () => {
    const { store, shadow } = mount('<otter-settings-menu></otter-settings-menu>');
    store.setState({ ...READY });
    (shadow('otter-settings-menu').querySelector('button') as HTMLButtonElement).click();
    const groups = [...shadow('otter-settings-menu').querySelectorAll('[role="group"]')];
    expect(groups.length).toBe(8);
    for (const g of groups) {
      const label = shadow('otter-settings-menu').getElementById(g.getAttribute('aria-labelledby') ?? '');
      expect(label?.textContent).not.toBe('');
      for (const item of g.querySelectorAll('[role="menuitemradio"]')) expect(['true', 'false']).toContain(item.getAttribute('aria-checked'));
    }
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
    core.store.dispatch('zoom', { scale: 9 });
    expect(core.store.getState().zoom).toBe(4);
  });
});
