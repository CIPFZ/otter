// @vitest-environment happy-dom
// Companion mode (ADR-016): docpip plus presentation.companion, the window size per step, the
// companion actions and the root's mark.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore, type QoeEventMap } from '@otter-player/core';
import { createPresentationPlugin, PRESENTATION_SLICE, type PresentationActionMap, type PresentationPluginOptions, type PresentationState } from '@otter-player/presentation';
import type { Surface } from '@otter-player/surface';

const restores: (() => void)[] = [];
const stub = (target: object, key: string, value: unknown): void => {
  const had = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restores.push(() => (had === undefined ? delete (target as Record<string, unknown>)[key] : Object.defineProperty(target, key, had)));
};
afterEach(() => {
  for (const r of restores.splice(0).reverse()) r();
});

/** A Document PiP window: its own document, a frame of 34 px, resizeTo sizes the outer window. */
function pipWindow(opts: { refuseResize?: boolean } = {}) {
  const doc = document.implementation.createHTMLDocument('pip');
  const win = Object.assign(new EventTarget(), {
    document: doc,
    innerWidth: 0,
    innerHeight: 0,
    outerWidth: 0,
    outerHeight: 0,
    close: () => win.dispatchEvent(new Event('pagehide')),
    resizeTo: vi.fn((w: number, h: number) => {
      if (opts.refuseResize === true) throw Object.assign(new Error('needs activation'), { name: 'NotAllowedError' });
      win.innerWidth = w;
      win.innerHeight = h - 34;
    }),
  });
  Object.defineProperty(win, 'outerWidth', { get: () => win.innerWidth });
  Object.defineProperty(win, 'outerHeight', { get: () => win.innerHeight + 34 });
  Object.defineProperty(doc, 'defaultView', { configurable: true, get: () => win });
  return win;
}

async function setup(options: Partial<PresentationPluginOptions>, env: { docpip?: boolean; refuseResize?: boolean } = {}) {
  const container = document.createElement('div');
  const video = document.createElement('video');
  container.append(video);
  document.body.replaceChildren(container);
  stub(document, 'pictureInPictureEnabled', true);
  stub(document, 'pictureInPictureElement', null);
  stub(document, 'exitPictureInPicture', vi.fn(async () => stub(document, 'pictureInPictureElement', null)));
  video.requestPictureInPicture = vi.fn(async () => {
    stub(document, 'pictureInPictureElement', video);
    return {} as PictureInPictureWindow;
  });
  const win = pipWindow(env);
  const requestWindow = vi.fn(async (size: { width: number; height: number }) => {
    win.innerWidth = size.width;
    win.innerHeight = size.height;
    return win as unknown as Window;
  });
  if (env.docpip !== false) stub(window, 'documentPictureInPicture', { requestWindow });
  // A 16:9 picture.
  const surface = { element: video, contentRect: { x: 0, y: 0, width: 640, height: 360 } } as unknown as Surface;
  type S = PresentationState & { danmaku: { enabled: boolean }; textTrack: string | null; paused: boolean };
  type A = PresentationActionMap & { 'set-danmaku': { enabled?: boolean }; 'select-text-track': { id: string | null }; pause: undefined };
  const plugin = createPresentationPlugin<S>({ container, surface, ...options });
  const core = createCore<S, A>({ slices: [PRESENTATION_SLICE, { id: 'media', initialState: { danmaku: { enabled: true }, textTrack: 'en', paused: false } }], plugins: [plugin] });
  // Stand-ins for the danmaku, text and media plugins; every dispatch is recorded.
  const calls: [string, unknown][] = [];
  core.store.handle('set-danmaku', (p) => {
    calls.push(['set-danmaku', p]);
    core.store.setState({ danmaku: { enabled: p.enabled ?? true } });
  });
  core.store.handle('select-text-track', (p) => {
    calls.push(['select-text-track', p]);
    core.store.setState({ textTrack: p.id });
  });
  core.store.handle('pause', () => {
    calls.push(['pause', undefined]);
    core.store.setState({ paused: true });
  });
  const denied: QoeEventMap['presentation-denied'][] = [];
  core.qoe.on('presentation-denied', (p) => void denied.push(p));
  await core.start();
  const state = () => core.store.getState().presentation;
  return { core, container, video, win, requestWindow, denied, state, calls };
}

describe('companion mode', () => {
  it('is off unless the host turns it on: toggle-pip keeps its rules, nothing to toggle', async () => {
    const { core, state, video, requestWindow } = await setup({});
    expect(state().companion).toMatchObject({ supported: false, active: false, dim: 0.4, audioOnly: false, remember: true });
    expect(core.store.dispatch('toggle-companion', {})).toBe(false);
    core.store.dispatch('toggle-pip', {});
    expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
    expect(requestWindow).not.toHaveBeenCalled();
    await core.destroy();
  });

  it('toggle-pip opens the companion window at the host\'s size step, marks the root, and leaves it again', async () => {
    const { core, state, container, win, requestWindow } = await setup({ companion: { dim: 0.6 } });
    expect(state().companion).toMatchObject({ supported: true, active: false, dim: 0.6 });
    core.store.dispatch('toggle-pip', {});
    // Without the browser's "back to tab" button (ADR-016 conflict 4).
    expect(requestWindow).toHaveBeenCalledWith({ width: 320, height: 180, disallowReturnToOpener: true });
    await vi.waitFor(() => expect(state().mode).toBe('docpip'));
    expect(state().companion.active).toBe(true);
    expect(container.hasAttribute('data-otter-companion')).toBe(true);
    expect(container.ownerDocument).toBe(win.document);
    core.store.dispatch('toggle-companion', {});
    expect(state().mode).toBe('inline');
    expect(state().companion.active).toBe(false);
    expect(container.hasAttribute('data-otter-companion')).toBe(false);
    expect(container.ownerDocument).toBe(document);
    await core.destroy();
  });

  it('companion-set: dim clamped to 0..0.8 (no resize); the size step only sets the first request', async () => {
    const { core, state, win, requestWindow } = await setup({ companion: { size: 'l' } });
    core.store.dispatch('companion-set', { dim: 0.95 });
    expect(state().companion.dim).toBe(0.8);
    core.store.dispatch('companion-set', { dim: -1 });
    expect(state().companion.dim).toBe(0);
    core.store.dispatch('toggle-companion', {});
    expect(requestWindow).toHaveBeenCalledWith({ width: 440, height: 248, disallowReturnToOpener: true });
    await vi.waitFor(() => expect(state().companion.active).toBe(true));
    core.store.dispatch('companion-set', { dim: 0.4 });
    expect(win.resizeTo).not.toHaveBeenCalled();
    await core.destroy();
  });

  it('the audio strip keeps the window\'s width (the viewer may have dragged it) and gives back its size', async () => {
    const { core, state, win } = await setup({ companion: true });
    core.store.dispatch('toggle-companion', {});
    await vi.waitFor(() => expect(state().companion.active).toBe(true));
    // The viewer drags the window to 400 x 225.
    win.innerWidth = 400;
    win.innerHeight = 225;
    core.store.dispatch('companion-set', { audioOnly: true });
    expect(win.resizeTo).toHaveBeenLastCalledWith(400, 66 + 34);
    core.store.dispatch('companion-set', { audioOnly: false });
    expect(win.resizeTo).toHaveBeenLastCalledWith(400, 225 + 34);
    expect([win.innerWidth, win.innerHeight]).toEqual([400, 225]);
    await core.destroy();
  });

  it('a resize the browser refuses (no gesture) keeps the window and says why', async () => {
    const { core, state, denied } = await setup({ companion: true }, { refuseResize: true });
    core.store.dispatch('toggle-companion', {});
    await vi.waitFor(() => expect(state().companion.active).toBe(true));
    core.store.dispatch('companion-set', { audioOnly: true });
    expect(state().companion.audioOnly).toBe(true);
    expect(denied).toEqual([{ from: 'docpip', to: 'docpip', reason: 'noUserGesture' }]);
    await core.destroy();
  });

  it('without Document PiP: not supported, toggle-pip is video PiP, toggle-companion is denied', async () => {
    const { core, state, video, denied } = await setup({ companion: true }, { docpip: false });
    expect(state().companion.supported).toBe(false);
    core.store.dispatch('toggle-companion', {});
    expect(denied).toEqual([{ from: 'inline', to: 'docpip', reason: 'unsupported' }]);
    core.store.dispatch('toggle-pip', {});
    expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
    await core.destroy();
  });

  it('destroy in the window leaves no mark on the root', async () => {
    const { core, state, container } = await setup({ companion: true });
    core.store.dispatch('toggle-pip', {});
    await vi.waitFor(() => expect(state().companion.active).toBe(true));
    await core.destroy();
    expect(container.hasAttribute('data-otter-companion')).toBe(false);
  });

  it('audio strip: 66 px of content at the width step, entering or switching; the root is marked', async () => {
    const { core, state, container, win, requestWindow } = await setup({ companion: { audioOnly: true, size: 's' } });
    core.store.dispatch('toggle-companion', {});
    expect(requestWindow).toHaveBeenCalledWith({ width: 240, height: 66, disallowReturnToOpener: true });
    await vi.waitFor(() => expect(state().companion.active).toBe(true));
    expect(container.hasAttribute('data-otter-audio-only')).toBe(true);
    core.store.dispatch('companion-set', { audioOnly: false });
    expect(win.resizeTo).toHaveBeenLastCalledWith(240, 135 + 34);
    expect(container.hasAttribute('data-otter-audio-only')).toBe(false);
    core.store.dispatch('companion-set', { audioOnly: true });
    expect(win.resizeTo).toHaveBeenLastCalledWith(240, 66 + 34);
    core.store.dispatch('toggle-companion', {});
    expect(container.hasAttribute('data-otter-audio-only')).toBe(false);
    await core.destroy();
  });

  it('quiet: danmaku and captions off in the window, back as they were on leaving; quieted meanwhile', async () => {
    const { core, state, calls } = await setup({ companion: true });
    core.store.dispatch('toggle-companion', {});
    await vi.waitFor(() => expect(state().companion.active).toBe(true));
    expect(calls).toEqual([
      ['set-danmaku', { enabled: false }],
      ['select-text-track', { id: null }],
    ]);
    expect(state().companion.quieted).toBe(true);
    // Turned back on in the window: only for this time.
    core.store.dispatch('set-danmaku', { enabled: true });
    calls.length = 0;
    core.store.dispatch('toggle-companion', {});
    expect(calls).toEqual([['select-text-track', { id: 'en' }]]);
    expect(core.store.getState().danmaku.enabled).toBe(true);
    expect(core.store.getState().textTrack).toBe('en');
    expect(state().companion.quieted).toBe(false);
    await core.destroy();
  });

  it('quiet: false leaves them alone', async () => {
    const { core, state, calls } = await setup({ companion: { quiet: false } });
    core.store.dispatch('toggle-companion', {});
    await vi.waitFor(() => expect(state().companion.active).toBe(true));
    core.store.dispatch('toggle-companion', {});
    expect(calls).toEqual([]);
    expect(state().companion.quieted).toBe(false);
    await core.destroy();
  });

  it('onClose: the viewer closing the window pauses (default) or not; the player\'s own way back never does', async () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const paused = async (options: Partial<PresentationPluginOptions>, leave: (core: Awaited<ReturnType<typeof setup>>) => void): Promise<boolean> => {
      const env = await setup(options);
      env.core.store.dispatch('toggle-pip', {});
      await vi.waitFor(() => expect(env.state().companion.active).toBe(true));
      leave(env);
      expect(env.state().mode).toBe('inline');
      const out = env.calls.some(([type]) => type === 'pause');
      await env.core.destroy();
      return out;
    };
    // The browser's close: the window goes, nothing in the player asked for it.
    expect(await paused({ companion: { quiet: false } }, (e) => e.win.close())).toBe(true);
    expect(await paused({ companion: { quiet: false, onClose: 'continue' } }, (e) => e.win.close())).toBe(false);
    // Back to the page (the button in the window dispatches toggle-pip): playback carries on, the page gets focus.
    focus.mockClear();
    expect(await paused({ companion: { quiet: false } }, (e) => e.core.store.dispatch('toggle-pip', {}))).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    expect(await paused({ companion: { quiet: false } }, (e) => e.core.store.dispatch('exit-presentation', {}))).toBe(false);
    focus.mockRestore();
  });
});
