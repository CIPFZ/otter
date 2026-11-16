// @vitest-environment happy-dom
// Companion mode in the player UI (ADR-016 §3, §4): the dim layer and the controls on hover.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, createStore } from '@otter-player/core';
import { MEDIA_SLICE, type MediaActionMap, type MediaState } from '@otter-player/media';
import { INITIAL_PRESENTATION_STATE, PRESENTATION_SLICE, type CompanionState, type PresentationState } from '@otter-player/presentation';
import { attachCompanionTools, bindActivity, createPlayerUiPlugin, defineOtterElements, PLAYER_UI_SLICE, provideStore, type PlayerUiActionMap, type PlayerUiState, type UiActions, type UiState } from '@otter-player/ui-core';

defineOtterElements();

const companion = (patch: Partial<CompanionState>): PresentationState['presentation'] => ({
  ...INITIAL_PRESENTATION_STATE.presentation,
  companion: { ...INITIAL_PRESENTATION_STATE.presentation.companion, supported: true, ...patch },
});

describe('companion dim layer', () => {
  it('is max(1 - brightness, dim) in the window (capped at 0.8) and 1 - brightness outside', () => {
    const store = createStore<UiState, UiActions>({ slices: [MEDIA_SLICE, PLAYER_UI_SLICE, PRESENTATION_SLICE] });
    const root = document.createElement('div');
    root.innerHTML = '<otter-gesture></otter-gesture>';
    document.body.replaceChildren(root);
    provideStore(root, store.view());
    const dim = (): string => ((root.querySelector('otter-gesture') as HTMLElement).shadowRoot?.querySelector('.dim') as HTMLElement).style.opacity;

    store.setState({ presentation: companion({ active: true, dim: 0.4 }) });
    expect(dim()).toBe('0.4');
    store.setState({ brightness: 0.3 });
    expect(Number(dim())).toBeCloseTo(0.7);
    store.setState({ brightness: 1, presentation: companion({ active: true, dim: 0.8 }) });
    expect(dim()).toBe('0.8');
    // Back in the page: brightness only; the companion setting does not touch brightness.
    store.setState({ brightness: 0.6, presentation: companion({ active: false, dim: 0.8 }) });
    expect(dim()).toBe('0.4');
    expect(store.getState().brightness).toBe(0.6);
  });
});

describe('controls in the companion window', () => {
  afterEach(() => vi.useRealTimers());

  async function setup() {
    vi.useFakeTimers();
    type S = MediaState & PlayerUiState & PresentationState;
    const core = createCore<S, PlayerUiActionMap & MediaActionMap>({ slices: [MEDIA_SLICE, PLAYER_UI_SLICE, PRESENTATION_SLICE], plugins: [createPlayerUiPlugin({ idleMs: 1000 })] });
    await core.start();
    return core.store;
  }

  it('hidden while playing until the pointer comes in; no timer while it stays; hidden when it leaves', async () => {
    const s = await setup();
    s.setState({ status: 'ready', paused: false });
    s.setState({ presentation: companion({ active: true }) });
    expect(s.getState().controlsVisible).toBe(false);
    // Playback and media changes do not show them.
    s.setState({ paused: true });
    s.setState({ paused: false, currentTime: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.getState().controlsVisible).toBe(false);
    s.dispatch('show-controls', {});
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.getState().controlsVisible).toBe(true);
    s.dispatch('hide-controls', {});
    expect(s.getState().controlsVisible).toBe(false);
  });

  it('an open menu keeps them; out of the window the idle delay is back', async () => {
    const s = await setup();
    s.setState({ status: 'ready', paused: false, presentation: companion({ active: true }) });
    s.dispatch('open-menu', { id: 'settings' });
    s.dispatch('hide-controls', {});
    expect(s.getState().controlsVisible).toBe(true);
    s.dispatch('open-menu', { id: null });
    s.dispatch('hide-controls', {});
    expect(s.getState().controlsVisible).toBe(false);
    s.setState({ presentation: companion({ active: false }) });
    expect(s.getState().controlsVisible).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.getState().controlsVisible).toBe(false);
    // Outside the window hide-controls changes nothing.
    s.dispatch('show-controls', {});
    s.dispatch('hide-controls', {});
    expect(s.getState().controlsVisible).toBe(true);
  });
});

describe('the audio strip and the companion settings', () => {
  afterEach(() => vi.useRealTimers());

  it('the audio strip keeps the controls shown, no timer, hide-controls ignored', async () => {
    vi.useFakeTimers();
    type S = MediaState & PlayerUiState & PresentationState;
    const core = createCore<S, PlayerUiActionMap & MediaActionMap>({ slices: [MEDIA_SLICE, PLAYER_UI_SLICE, PRESENTATION_SLICE], plugins: [createPlayerUiPlugin({ idleMs: 1000 })] });
    await core.start();
    const s = core.store;
    s.setState({ status: 'ready', paused: false, presentation: companion({ active: true, audioOnly: true }) });
    await vi.advanceTimersByTimeAsync(5000);
    s.dispatch('hide-controls', {});
    expect(s.getState().controlsVisible).toBe(true);
    // Strip off in the window: hover rules.
    s.setState({ presentation: companion({ active: true, audioOnly: false }) });
    expect(s.getState().controlsVisible).toBe(false);
  });

  it('the PiP button is "back to the page" in the window; the settings menu has a companion page only when supported', async () => {
    const store = createStore<UiState, UiActions>({ slices: [MEDIA_SLICE, PLAYER_UI_SLICE, PRESENTATION_SLICE] });
    const sets: unknown[] = [];
    store.handle('companion-set', (p) => {
      sets.push(p);
      const c = store.getState().presentation?.companion;
      if (c !== undefined) store.setState({ presentation: companion({ ...c, ...p }) });
    });
    store.handle('open-menu', ({ id }) => store.setState({ menu: id }));
    const root = document.createElement('div');
    root.setAttribute('lang', 'zh-CN');
    root.innerHTML = '<otter-pip-button></otter-pip-button><otter-settings-menu></otter-settings-menu>';
    document.body.replaceChildren(root);
    provideStore(root, store.view());
    store.setState({ presentation: { ...INITIAL_PRESENTATION_STATE.presentation, capabilities: { ...INITIAL_PRESENTATION_STATE.presentation.capabilities, docpip: 'native' } } });
    const pipLabel = (): string | null => (root.querySelector('otter-pip-button') as HTMLElement).shadowRoot?.querySelector('button')?.getAttribute('aria-label') ?? null;
    expect(pipLabel()).toBe('画中画');
    store.setState({ presentation: companion({ active: true }) });
    expect(pipLabel()).toBe('回到页面');

    const menu = root.querySelector('otter-settings-menu') as HTMLElement;
    const panel = (): ShadowRoot => menu.shadowRoot as ShadowRoot;
    const open = async (): Promise<void> => {
      (panel().querySelector('button') as HTMLElement).click();
      await vi.waitFor(() => expect(panel().querySelector('[data-key="row:picture"]')).not.toBeNull());
    };
    // Not supported: no row.
    store.setState({ presentation: companion({ supported: false }) });
    await open();
    expect(panel().querySelector('[data-key="row:companion"]')).toBeNull();
    (panel().querySelector('button') as HTMLElement).click();
    // Supported: the row says the current settings; the page sets them.
    store.setState({ presentation: companion({ supported: true, dim: 0.4 }) });
    await open();
    const row = panel().querySelector('[data-key="row:companion"]') as HTMLElement;
    expect(row.getAttribute('aria-label')).toBe('悬浮窗, 40%');
    row.click();
    await vi.waitFor(() => expect(panel().querySelector('[data-key="companion-dim:4"]')).not.toBeNull());
    // No size steps: the viewer drags the window's edge.
    expect([...panel().querySelectorAll('[data-group="companion"][role="menuitemradio"]')].map((b) => b.textContent)).toEqual(['0%', '20%', '40%', '60%', '80%', '开', '关']);
    (panel().querySelector('[data-key="companion-dim:4"]') as HTMLElement).click();
    (panel().querySelector('[data-key="companion-audio:0"]') as HTMLElement).click();
    expect(sets).toEqual([{ dim: 0.8 }, { audioOnly: true }]);
    await vi.waitFor(() => expect(panel().querySelector('[data-key="companion-audio:0"]')?.getAttribute('aria-checked')).toBe('true'));
  });
});

describe('bindActivity', () => {
  it('reports hide-controls when the mouse leaves, or the focus leaves, the player', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button id="a"></button><button id="b"></button>';
    document.body.replaceChildren(root);
    const calls: string[] = [];
    const off = bindActivity(root, { dispatch: (type) => (calls.push(type), true) });
    const a = root.querySelector('#a') as HTMLElement;
    const b = root.querySelector('#b') as HTMLElement;
    root.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse' }));
    root.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    root.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'touch' }));
    expect(calls).toEqual(['show-controls', 'hide-controls']);
    calls.length = 0;
    // Focus moving between controls stays; leaving the player reports.
    a.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: b }));
    expect(calls).toEqual([]);
    a.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    expect(calls).toEqual(['hide-controls']);
    off();
    root.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    expect(calls).toEqual(['hide-controls']);
  });
});

describe('companion window controls (attachCompanionTools)', () => {
  async function mounted(lang = 'en') {
    const store = createStore<UiState, UiActions>({ slices: [MEDIA_SLICE, PLAYER_UI_SLICE, PRESENTATION_SLICE] });
    const sets: unknown[] = [];
    store.handle('companion-set', (p) => {
      sets.push(p);
      const c = store.getState().presentation?.companion;
      if (c !== undefined) store.setState({ presentation: companion({ ...c, ...p }) });
    });
    store.setState({ presentation: companion({ active: true, dim: 0.4 }) });
    const root = document.createElement('div');
    root.setAttribute('lang', lang);
    root.innerHTML = '<div data-otter-controls><otter-pip-button></otter-pip-button></div>';
    document.body.replaceChildren(root);
    provideStore(root, store.view());
    const off = attachCompanionTools(root, store.view());
    await vi.waitFor(() => expect(root.querySelector('[data-otter-companion-tools]')).not.toBeNull());
    const slider = root.querySelector('[role="slider"]') as HTMLElement;
    return { store, root, sets, off, slider };
  }

  it('a five-step dimming slider: keys, wheel and a click snap to 0 / 20 / 40 / 60 / 80 %', async () => {
    const { store, sets, slider, root, off } = await mounted('zh-CN');
    expect(slider.getAttribute('aria-label')).toBe('暗化');
    expect([slider.getAttribute('aria-valuenow'), slider.getAttribute('aria-valuetext')]).toEqual(['40', '40%']);
    expect(root.querySelectorAll('.ot-tick')).toHaveLength(5);
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    slider.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    // A press 70 % along the track: the nearest step is 3 of 0..4, i.e. 60 %.
    const track = root.querySelector('.ot-track') as HTMLElement;
    track.getBoundingClientRect = () => ({ left: 100, width: 80, top: 0, height: 16, right: 180, bottom: 16, x: 100, y: 0, toJSON: () => ({}) });
    slider.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100 + 80 * 0.7, button: 0, bubbles: true }));
    expect(sets.map((p) => (p as { dim: number }).dim)).toEqual([0.6, 0, 0.2, 0.6]);
    expect(store.getState().presentation?.companion.dim).toBe(0.6);
    expect(slider.getAttribute('aria-valuetext')).toBe('60%');
    off();
    expect(root.querySelector('[data-otter-companion-tools]')).toBeNull();
  });

  it('the audio strip switch, and "show picture" in the bar; hidden with the controls', async () => {
    const { store, sets, root, off } = await mounted();
    const strip = root.querySelector('.ot-strip') as HTMLButtonElement;
    const show = root.querySelector('[data-otter-show-picture]') as HTMLButtonElement;
    expect(strip.getAttribute('aria-label')).toBe('Audio only');
    expect(show.getAttribute('aria-label')).toBe('Show picture');
    // In the bar, just before the way back to the page.
    expect(show.nextElementSibling?.tagName.toLowerCase()).toBe('otter-pip-button');
    strip.click();
    show.click();
    expect(sets).toEqual([{ audioOnly: true }, { audioOnly: false }]);
    const tools = root.querySelector('[data-otter-companion-tools]') as HTMLElement;
    store.setState({ controlsVisible: false });
    expect(tools.hasAttribute('data-idle')).toBe(true);
    store.setState({ controlsVisible: true });
    expect(tools.hasAttribute('data-idle')).toBe(false);
    off();
    expect(root.querySelector('[data-otter-show-picture]')).toBeNull();
  });
});
