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
  const plugin = createPresentationPlugin<PresentationState>({ container, surface, ...options });
  const core = createCore<PresentationState, PresentationActionMap>({ slices: [PRESENTATION_SLICE], plugins: [plugin] });
  const denied: QoeEventMap['presentation-denied'][] = [];
  core.qoe.on('presentation-denied', (p) => void denied.push(p));
  await core.start();
  const state = () => core.store.getState().presentation;
  return { core, container, video, win, requestWindow, denied, state };
}

describe('companion mode', () => {
  it('is off unless the host turns it on: toggle-pip keeps its rules, nothing to toggle', async () => {
    const { core, state, video, requestWindow } = await setup({});
    expect(state().companion).toMatchObject({ supported: false, active: false, dim: 0.4, size: 'm', audioOnly: false, remember: true });
    expect(core.store.dispatch('toggle-companion', {})).toBe(false);
    core.store.dispatch('toggle-pip', {});
    expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
    expect(requestWindow).not.toHaveBeenCalled();
    await core.destroy();
  });

  it('toggle-pip opens the companion window at the size step, marks the root, and leaves it again', async () => {
    const { core, state, container, win, requestWindow } = await setup({ companion: { dim: 0.6 } });
    expect(state().companion).toMatchObject({ supported: true, active: false, dim: 0.6, size: 'm' });
    core.store.dispatch('toggle-pip', {});
    expect(requestWindow).toHaveBeenCalledWith({ width: 320, height: 180 });
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

  it('companion-set: dim clamped to 0..0.8; a new size resizes the open window (outer = content + frame)', async () => {
    const { core, state, win } = await setup({ companion: true });
    core.store.dispatch('companion-set', { dim: 0.95, size: 'l', audioOnly: true });
    expect(state().companion).toMatchObject({ dim: 0.8, size: 'l', audioOnly: true });
    // Not in the window: nothing to resize.
    expect(win.resizeTo).not.toHaveBeenCalled();
    core.store.dispatch('companion-set', { dim: -1, size: 'm' });
    expect(state().companion.dim).toBe(0);
    core.store.dispatch('toggle-companion', {});
    await vi.waitFor(() => expect(state().companion.active).toBe(true));
    core.store.dispatch('companion-set', { size: 's' });
    expect(win.resizeTo).toHaveBeenCalledWith(240, 135 + 34);
    expect([win.innerWidth, win.innerHeight]).toEqual([240, 135]);
    // Same size: no resize.
    core.store.dispatch('companion-set', { size: 's', dim: 0.2 });
    expect(win.resizeTo).toHaveBeenCalledOnce();
    await core.destroy();
  });

  it('a resize the browser refuses (no gesture) keeps the window and says why', async () => {
    const { core, state, denied } = await setup({ companion: true }, { refuseResize: true });
    core.store.dispatch('toggle-companion', {});
    await vi.waitFor(() => expect(state().companion.active).toBe(true));
    core.store.dispatch('companion-set', { size: 'l' });
    expect(state().companion.size).toBe('l');
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
});
