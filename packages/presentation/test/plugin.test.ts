// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, type QoeEventMap } from '@otter-player/core';
import { createPresentationPlugin, PRESENTATION_SLICE, type PresentationActionMap, type PresentationPluginOptions, type PresentationState } from '@otter-player/presentation';
import type { Surface } from '@otter-player/surface';

type State = PresentationState & { paused: boolean; currentTime: number; duration: number; playbackRate: number };
type Actions = PresentationActionMap & { play: undefined; pause: undefined; seek: { time: number }; 'seek-by': { seconds: number } };

const define = (target: object, key: string, value: unknown): void => {
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
};
const restores: (() => void)[] = [];
/** Temporarily replaces `key` on `target` (navigator, document, window). */
const stub = (target: object, key: string, value: unknown): void => {
  const had = Object.getOwnPropertyDescriptor(target, key);
  define(target, key, value);
  restores.push(() => (had === undefined ? delete (target as Record<string, unknown>)[key] : Object.defineProperty(target, key, had)));
};
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r();
});

interface Env {
  /** Element fullscreen API present (false: iPhone-like). */
  fullscreen?: boolean;
  rejectFullscreen?: string;
}

async function setup(env: Env = {}, options: Partial<PresentationPluginOptions> = {}) {
  const container = document.createElement('div');
  const video = document.createElement('video');
  container.append(video);
  document.body.replaceChildren(container);
  let fsElement: Element | null = null;
  stub(document, 'fullscreenEnabled', env.fullscreen !== false);
  stub(document, 'pictureInPictureEnabled', true);
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsElement });
  restores.push(() => delete (document as { fullscreenElement?: unknown }).fullscreenElement);
  if (env.fullscreen !== false) {
    container.requestFullscreen = vi.fn(async () => {
      if (env.rejectFullscreen !== undefined) throw Object.assign(new Error('denied'), { name: env.rejectFullscreen });
      fsElement = container;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
  } else {
    define(container, 'requestFullscreen', undefined);
  }
  stub(document, 'exitFullscreen', vi.fn(async () => {
    fsElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  }));
  video.requestPictureInPicture = vi.fn(async () => {
    stub(document, 'pictureInPictureElement', video);
    video.dispatchEvent(new Event('enterpictureinpicture'));
    return {} as PictureInPictureWindow;
  });
  const surface = { element: video } as unknown as Surface;
  const plugin = createPresentationPlugin<State>({ container, surface, ...options });
  const core = createCore<State, Actions>({
    slices: [PRESENTATION_SLICE, { id: 'media', initialState: { paused: true, currentTime: 0, duration: 60, playbackRate: 1 } }],
    plugins: [plugin],
  });
  const qoe: { type: string; payload: unknown }[] = [];
  for (const type of ['presentation-change', 'presentation-denied'] as const) core.qoe.on(type, (payload: QoeEventMap[typeof type]) => void qoe.push({ type, payload }));
  await core.start();
  await plugin.ready;
  const mode = (): string => core.store.getState().presentation.mode;
  return { core, container, video, plugin, qoe, mode, exitFullscreenNatively: () => ((fsElement = null), document.dispatchEvent(new Event('fullscreenchange'))) };
}

describe('presentation controller', () => {
  it('reports capabilities from feature detection', async () => {
    const { core } = await setup();
    expect(core.store.getState().presentation.capabilities).toEqual({
      inline: 'native',
      theater: 'emulated',
      fullscreen: 'native',
      pip: 'native',
      docpip: false,
      mini: typeof IntersectionObserver === 'function' ? 'emulated' : false,
      background: 'native',
    });
  });

  it('fullscreen: API called inside the dispatch, pending until the browser confirms, user exit returns inline', async () => {
    const { core, container, qoe, mode, exitFullscreenNatively } = await setup();
    core.store.dispatch('toggle-fullscreen', {});
    expect(container.requestFullscreen).toHaveBeenCalledOnce();
    // Not optimistic: still inline while the browser decides.
    expect(core.store.getState().presentation).toMatchObject({ mode: 'inline', pending: 'fullscreen' });
    await vi.waitFor(() => expect(mode()).toBe('fullscreen'));
    expect(core.store.getState().presentation.pending).toBeNull();
    expect(container.getAttribute('data-otter-presentation')).toBe('fullscreen');
    exitFullscreenNatively();
    expect(mode()).toBe('inline');
    expect(qoe).toEqual([
      { type: 'presentation-change', payload: { from: 'inline', to: 'fullscreen' } },
      { type: 'presentation-change', payload: { from: 'fullscreen', to: 'inline', reason: 'exited' } },
    ]);
  });

  it('a refused request rolls back and emits denied with a reason', async () => {
    const { core, qoe, mode } = await setup({ rejectFullscreen: 'NotAllowedError' });
    core.store.dispatch('toggle-fullscreen', {});
    await vi.waitFor(() => expect(qoe).toHaveLength(1));
    expect(qoe[0]).toEqual({ type: 'presentation-denied', payload: { from: 'inline', to: 'fullscreen', reason: 'notAllowed' } });
    expect(mode()).toBe('inline');
    expect(core.store.getState().presentation.pending).toBeNull();
  });

  it('without a user gesture the reason is noUserGesture; a second request while pending is busy', async () => {
    stub(navigator, 'userActivation', { isActive: false });
    const { plugin, qoe } = await setup({ rejectFullscreen: 'NotAllowedError' });
    const c = plugin.controller;
    if (c === undefined) throw new Error('not installed');
    const first = c.request('fullscreen');
    expect(await c.request('theater')).toBe('inline');
    await first;
    expect(qoe.map((e) => (e.payload as { reason: string }).reason)).toEqual(['busy', 'noUserGesture']);
  });

  it('iPhone (no element fullscreen): pseudo-fullscreen keeps the custom UI and locks page scrolling', async () => {
    const { core, container, mode } = await setup({ fullscreen: false });
    expect(core.store.getState().presentation.capabilities.fullscreen).toBe('emulated');
    core.store.dispatch('toggle-fullscreen', {});
    await vi.waitFor(() => expect(mode()).toBe('fullscreen'));
    expect(container.hasAttribute('data-otter-emulated')).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    expect(core.store.getState().presentation.videoOnly).toBe(false);
    // Esc with no menu open (chrome plugin) -> exit-fullscreen.
    core.store.dispatch('exit-fullscreen', {});
    await vi.waitFor(() => expect(mode()).toBe('inline'));
    expect(document.body.style.overflow).toBe('');
    expect(container.hasAttribute('data-otter-emulated')).toBe(false);
  });

  it('iPhone system fullscreen (webkitEnterFullscreen) is video-only', async () => {
    const { core, video, mode } = await setup({ fullscreen: false });
    define(video, 'webkitEnterFullscreen', () => {
      define(video, 'webkitDisplayingFullscreen', true);
      video.dispatchEvent(new Event('webkitbeginfullscreen'));
    });
    core.store.dispatch('request-presentation', { mode: 'fullscreen', system: true });
    await vi.waitFor(() => expect(mode()).toBe('fullscreen'));
    expect(core.store.getState().presentation.videoOnly).toBe(true);
    define(video, 'webkitDisplayingFullscreen', false);
    video.dispatchEvent(new Event('webkitendfullscreen'));
    expect(mode()).toBe('inline');
  });

  it('theater is layout only; fullscreen from theater returns to theater', async () => {
    const { core, container, mode, exitFullscreenNatively } = await setup();
    core.store.dispatch('toggle-theater', {});
    await vi.waitFor(() => expect(mode()).toBe('theater'));
    expect(container.hasAttribute('data-otter-theater')).toBe(true);
    core.store.dispatch('toggle-fullscreen', {});
    await vi.waitFor(() => expect(mode()).toBe('fullscreen'));
    expect(container.hasAttribute('data-otter-theater')).toBe(false);
    exitFullscreenNatively();
    expect(mode()).toBe('theater');
    core.store.dispatch('toggle-theater', {});
    expect(mode()).toBe('inline');
  });

  it('video PiP is video-only and returns inline when the PiP window closes', async () => {
    const { core, video, mode } = await setup();
    core.store.dispatch('toggle-pip', {});
    expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mode()).toBe('pip'));
    expect(core.store.getState().presentation.videoOnly).toBe(true);
    stub(document, 'pictureInPictureElement', null);
    video.dispatchEvent(new Event('leavepictureinpicture', { bubbles: true }));
    expect(mode()).toBe('inline');
  });

  it('background is entered passively on hide, never by request', async () => {
    const { core, qoe, mode } = await setup();
    core.store.dispatch('request-presentation', { mode: 'background' });
    await vi.waitFor(() => expect(qoe).toHaveLength(1));
    expect(qoe[0]?.payload).toEqual({ from: 'inline', to: 'background', reason: 'unsupported' });
    stub(document, 'visibilityState', 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mode()).toBe('background');
    stub(document, 'visibilityState', 'visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mode()).toBe('inline');
  });

  it('mini window keeps a placeholder in the page', async () => {
    const { core, container, mode } = await setup();
    core.store.dispatch('toggle-mini', {});
    await vi.waitFor(() => expect(mode()).toBe('mini'));
    expect(container.previousElementSibling?.hasAttribute('data-otter-placeholder')).toBe(true);
    core.store.dispatch('toggle-mini', {});
    await vi.waitFor(() => expect(mode()).toBe('inline'));
    expect(document.querySelector('[data-otter-placeholder]')).toBeNull();
  });

  it('mini window drags, remembers where it was left, and lets clicks through', async () => {
    localStorage.removeItem('otter:mini-position');
    const { core, container, mode } = await setup();
    // A 320x180 window in a 1024x768 viewport, at the default 16 px corner.
    container.getBoundingClientRect = () => {
      const right = 1024 - (Number.parseFloat(container.style.right) || 16);
      const bottom = 768 - (Number.parseFloat(container.style.bottom) || 16);
      return new DOMRect(right - 320, bottom - 180, 320, 180);
    };
    const seen: string[] = [];
    container.addEventListener('pointercancel', () => seen.push('cancel'));
    container.addEventListener('click', () => seen.push('click'));
    const pointer = (type: string, x: number, y: number) =>
      container.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true }));
    core.store.dispatch('toggle-mini', {});
    await vi.waitFor(() => expect(mode()).toBe('mini'));
    // The drag behaviour loads with the mode.
    await vi.waitFor(async () => {
      pointer('pointerdown', 900, 700);
      pointer('pointermove', 600, 500);
      expect(container.style.right).toBe('316px');
    });
    expect(container.style.bottom).toBe('216px');
    expect(container.hasAttribute('data-otter-dragging')).toBe(true);
    pointer('pointerup', 600, 500);
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The InputController got a pointercancel when the drag started; the closing click is swallowed.
    expect(seen).toEqual(['cancel']);
    expect(JSON.parse(localStorage.getItem('otter:mini-position') ?? 'null')).toEqual({ right: 316, bottom: 216 });
    // A plain click (no movement) still reaches the player.
    pointer('pointerdown', 700, 600);
    pointer('pointerup', 700, 600);
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen).toEqual(['cancel', 'click']);
    // Never dragged out of the viewport.
    pointer('pointerdown', 700, 600);
    pointer('pointermove', 5000, 5000);
    expect([container.style.right, container.style.bottom]).toEqual(['8px', '8px']);
    pointer('pointerup', 5000, 5000);
    core.store.dispatch('toggle-mini', {});
    await vi.waitFor(() => expect(mode()).toBe('inline'));
    expect(container.style.right).toBe('');
    // Next time it opens where it was left.
    core.store.dispatch('toggle-mini', {});
    await vi.waitFor(() => expect(container.style.right).toBe('8px'));
  });

  it('Document PiP moves the whole player and puts it back when the window closes', async () => {
    const pipDoc = document.implementation.createHTMLDocument('pip');
    const pipWindow = Object.assign(new EventTarget(), {
      document: pipDoc,
      close: () => pipWindow.dispatchEvent(new Event('pagehide')),
    });
    const requestWindow = vi.fn(async () => pipWindow as unknown as Window);
    stub(window, 'documentPictureInPicture', { requestWindow });
    const { core, container, mode } = await setup({}, { preferDocumentPip: true });
    expect(core.store.getState().presentation.capabilities.docpip).toBe('native');
    core.store.dispatch('toggle-pip', {});
    expect(requestWindow).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mode()).toBe('docpip'));
    expect(container.ownerDocument).toBe(pipDoc);
    expect(document.querySelector('[data-otter-placeholder]')).not.toBeNull();
    core.store.dispatch('toggle-pip', {});
    expect(mode()).toBe('inline');
    expect(container.ownerDocument).toBe(document);
    expect(document.querySelector('[data-otter-placeholder]')).toBeNull();
  });
});

describe('presentation companions', () => {
  it('Cast: availability from the Remote Playback API, prompt() inside the dispatch', async () => {
    const remote = Object.assign(new EventTarget(), {
      state: 'disconnected',
      watchAvailability: vi.fn(async (cb: (a: boolean) => void) => (cb(true), 1)),
      cancelWatchAvailability: vi.fn(async () => undefined),
      prompt: vi.fn(async () => undefined),
    });
    stub(HTMLMediaElement.prototype, 'remote', remote);
    const { core } = await setup();
    await vi.waitFor(() => expect(core.store.getState().cast).toBe('available'));
    core.store.dispatch('open-cast-picker', {});
    expect(remote.prompt).toHaveBeenCalledOnce();
    remote.state = 'connected';
    remote.dispatchEvent(new Event('connect'));
    expect(core.store.getState().cast).toBe('connected');
  });

  it('AirPlay: WebKit target availability and picker', async () => {
    const picker = vi.fn();
    stub(HTMLMediaElement.prototype, 'webkitShowPlaybackTargetPicker', picker);
    const { core, video } = await setup();
    expect(core.store.getState().airplay).toBe('unavailable');
    video.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' }));
    expect(core.store.getState().airplay).toBe('available');
    core.store.dispatch('open-airplay-picker', {});
    expect(picker).toHaveBeenCalledOnce();
  });

  it('WakeLock while playing, released on pause', async () => {
    const release = vi.fn();
    const sentinel = Object.assign(new EventTarget(), { release: vi.fn(async () => (release(), sentinel.dispatchEvent(new Event('release')))) });
    const request = vi.fn(async () => sentinel);
    stub(navigator, 'wakeLock', { request });
    const { core } = await setup();
    expect(request).not.toHaveBeenCalled();
    core.store.setState({ paused: false });
    await vi.waitFor(() => expect(core.store.getState().wakeLocked).toBe(true));
    core.store.setState({ paused: true });
    await vi.waitFor(() => expect(core.store.getState().wakeLocked).toBe(false));
    expect(release).toHaveBeenCalledOnce();
  });

  it('MediaSession: metadata, handlers dispatch media actions, playback state follows', async () => {
    const handlers = new Map<string, ((d: MediaSessionActionDetails) => void) | null>();
    const ms = { metadata: null as unknown, playbackState: 'none', setActionHandler: (a: string, h: ((d: MediaSessionActionDetails) => void) | null) => void handlers.set(a, h), setPositionState: vi.fn() };
    stub(navigator, 'mediaSession', ms);
    stub(globalThis, 'MediaMetadata', class {
      readonly init: MediaMetadataInit;
      constructor(init: MediaMetadataInit) {
        this.init = init;
      }
    });
    const { core } = await setup({}, { mediaSession: { metadata: { title: 'Otter' } } });
    const got: string[] = [];
    core.store.handle('play', () => void got.push('play'));
    core.store.handle('seek-by', ({ seconds }) => void got.push(`seek-by ${seconds}`));
    expect((ms.metadata as { init: MediaMetadataInit }).init.title).toBe('Otter');
    handlers.get('play')?.({ action: 'play' });
    handlers.get('seekbackward')?.({ action: 'seekbackward' });
    expect(got).toEqual(['play', 'seek-by -10']);
    core.store.setState({ paused: false, currentTime: 5 });
    expect(ms.playbackState).toBe('playing');
    expect(ms.setPositionState).toHaveBeenCalledWith(expect.objectContaining({ duration: 60, playbackRate: 1 }));
  });
});
