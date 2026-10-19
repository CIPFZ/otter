// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createCore } from '@otter-player/core';
import { createPresentationPlugin, PRESENTATION_SLICE, type PresentationActionMap, type PresentationState } from '@otter-player/presentation';
import type { Surface } from '@otter-player/surface';

async function setup() {
  const container = document.createElement('div');
  const video = document.createElement('video');
  container.append(video);
  document.body.replaceChildren(container);
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, value: true });
  let fsElement: Element | null = null;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsElement });
  container.requestFullscreen = vi.fn(async () => {
    fsElement = container;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  document.exitFullscreen = vi.fn(async () => {
    fsElement = null;
    document.dispatchEvent(new Event('fullscreenchange'));
  });
  video.requestPictureInPicture = vi.fn(async () => {
    video.dispatchEvent(new Event('enterpictureinpicture'));
    return {} as PictureInPictureWindow;
  });
  const surface = { element: video } as unknown as Surface;
  const core = createCore<PresentationState, PresentationActionMap>({ slices: [PRESENTATION_SLICE], plugins: [createPresentationPlugin({ container, surface })] });
  await core.start();
  return { core, container, video };
}

describe('presentation M2 plugin', () => {
  it('reports support and toggles fullscreen on the container synchronously', async () => {
    const { core, container } = await setup();
    expect(core.store.getState()).toMatchObject({ fullscreenAvailable: true, pipAvailable: true, fullscreen: false });
    core.store.dispatch('toggle-fullscreen', {});
    // Called inside the dispatch (user activation), not after an await.
    expect(container.requestFullscreen).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(core.store.getState().fullscreen).toBe(true));
    core.store.dispatch('toggle-fullscreen', {});
    expect(document.exitFullscreen).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(core.store.getState().fullscreen).toBe(false));
  });

  it('requests picture-in-picture from the video element', async () => {
    const { core, video } = await setup();
    core.store.dispatch('toggle-pip', {});
    expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
  });
});
