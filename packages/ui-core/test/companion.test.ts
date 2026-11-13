// @vitest-environment happy-dom
// Companion mode in the player UI (ADR-016 §3, §4): the dim layer and the controls on hover.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, createStore } from '@otter-player/core';
import { MEDIA_SLICE, type MediaActionMap, type MediaState } from '@otter-player/media';
import { INITIAL_PRESENTATION_STATE, PRESENTATION_SLICE, type CompanionState, type PresentationState } from '@otter-player/presentation';
import { bindActivity, createPlayerUiPlugin, defineOtterElements, PLAYER_UI_SLICE, provideStore, type PlayerUiActionMap, type PlayerUiState, type UiActions, type UiState } from '@otter-player/ui-core';

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
