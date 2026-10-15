// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createStore } from '@otter-player/core';
import { INITIAL_MEDIA_STATE, MEDIA_SLICE, type MediaActionMap } from '@otter-player/media';
import { EMPTY_QOE, QOE_SLICE } from '@otter-player/qoe';
import { defineOtterElements, formatTime, provideStore, speakTime, type UiState } from '@otter-player/ui-core';

defineOtterElements();

function mount(html: string) {
  const store = createStore<UiState, MediaActionMap>({ slices: [MEDIA_SLICE, QOE_SLICE] });
  const calls: [string, unknown, string | undefined][] = [];
  for (const type of ['toggle-paused', 'toggle-muted', 'seek'] as const) {
    store.handle(type, (payload, ctx) => calls.push([type, payload, ctx.trigger?.type]));
  }
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  provideStore(root, store.view());
  const shadow = (tag: string): ShadowRoot => (root.querySelector(tag) as HTMLElement).shadowRoot as ShadowRoot;
  return { store, root, calls, shadow };
}

describe('M1 elements', () => {
  it('play button dispatches toggle-paused synchronously and tracks state', () => {
    const { store, calls, shadow } = mount('<otter-play-button></otter-play-button>');
    const button = shadow('otter-play-button').querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    store.setState({ status: 'ready' });
    expect(button.getAttribute('aria-label')).toBe('Play');
    button.click();
    // Handler ran inside the click callback (user activation preserved).
    expect(calls).toEqual([['toggle-paused', {}, 'click']]);
    store.setState({ paused: false });
    expect(button.getAttribute('aria-label')).toBe('Pause');
  });

  it('mute button reflects muted and volume 0', () => {
    const { store, calls, shadow } = mount('<otter-mute-button></otter-mute-button>');
    const button = shadow('otter-mute-button').querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Mute');
    store.setState({ volume: 0 });
    expect(button.getAttribute('aria-label')).toBe('Unmute');
    button.click();
    expect(calls[0]?.[0]).toBe('toggle-muted');
  });

  it('time display and slider follow the playhead; slider seeks on change only', () => {
    const { store, calls, shadow } = mount('<otter-time-display></otter-time-display><otter-time-slider></otter-time-slider>');
    const input = shadow('otter-time-slider').querySelector('input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    store.setState({ duration: 90, currentTime: 75, bufferedEnd: 80 });
    expect(shadow('otter-time-display').querySelector('span')?.textContent).toBe('1:15 / 1:30');
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-valuetext')).toBe('1 minute 15 seconds of 1 minute 30 seconds');
    input.value = '30';
    input.dispatchEvent(new Event('input'));
    expect(calls).toEqual([]);
    input.dispatchEvent(new Event('change'));
    expect(calls).toEqual([['seek', { time: 30 }, 'change']]);
    store.setState({ live: true, duration: Number.POSITIVE_INFINITY });
    expect(shadow('otter-time-display').querySelector('span')?.textContent).toBe('LIVE');
    expect(input.disabled).toBe(true);
  });

  it('stats panel shows QoE and the route explanation', () => {
    const { store, shadow } = mount('<otter-stats></otter-stats>');
    store.setState({
      status: 'ready',
      format: 'hls',
      backend: 'mse',
      mms: true,
      videoWidth: 1280,
      videoHeight: 720,
      route: { format: 'hls', backend: 'mse', steps: [{ candidate: 'mse', outcome: 'selected', reason: 'first feasible candidate' }] },
      qoe: { ...EMPTY_QOE, ttff: 412, bandwidth: 4_200_000, droppedFrames: 3, totalFrames: 900 },
    });
    const stat = (k: string): string | null | undefined => shadow('otter-stats').querySelector(`[data-stat="${k}"]`)?.textContent;
    expect(stat('Format / backend')).toBe('hls / mse (ManagedMediaSource)');
    expect(stat('Resolution')).toBe('1280×720');
    expect(stat('Bandwidth')).toBe('4.2 Mbps');
    expect(stat('TTFF')).toBe('412 ms');
    expect(stat('Dropped frames')).toBe('3 / 900');
    expect(shadow('otter-stats').querySelector('pre')?.textContent).toContain('"first feasible candidate"');
  });

  it('elements connected before provideStore pick it up, and disconnect unsubscribes', () => {
    const store = createStore<UiState, MediaActionMap>({ slices: [MEDIA_SLICE, QOE_SLICE] });
    const subscribe = vi.spyOn(store, 'subscribe');
    const root = document.createElement('div');
    root.innerHTML = '<otter-time-display></otter-time-display>';
    document.body.append(root);
    const view = { ...store, subscribe: (...a: Parameters<typeof store.subscribe>) => subscribe(...a) };
    provideStore(root, view);
    expect(subscribe).toHaveBeenCalledTimes(1);
    root.remove();
    store.setState({ currentTime: 5, duration: 10 });
    expect((root.querySelector('otter-time-display') as HTMLElement).shadowRoot?.querySelector('span')?.textContent).toBe('0:00 / --:--');
  });

  it('defining twice is a no-op', () => {
    expect(() => defineOtterElements()).not.toThrow();
  });
});

describe('format', () => {
  it('formats and speaks times', () => {
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(Number.NaN)).toBe('--:--');
    expect(speakTime(61)).toBe('1 minute 1 second');
    expect(INITIAL_MEDIA_STATE.paused).toBe(true);
  });
});
