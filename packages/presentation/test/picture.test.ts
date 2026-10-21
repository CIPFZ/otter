// @vitest-environment happy-dom
// Picture plugin (SPEC §12 电子放大): zoom at a point, clamped pan, filters, reset, applied to the
// surface; overlays keep the fitted rect.
import { describe, expect, it } from 'vitest';
import { createCore } from '@otter-player/core';
import { createPicturePlugin, PICTURE_SLICE, ZOOM_MAX, type PictureActionMap, type PictureSliceState } from '@otter-player/presentation/picture';
import type { Surface, SurfaceFilters, SurfaceTransform } from '@otter-player/surface';

function fakeSurface() {
  const el = document.createElement('video');
  Object.defineProperties(el, {
    clientWidth: { value: 640 },
    clientHeight: { value: 360 },
    videoWidth: { value: 640 },
    videoHeight: { value: 360 },
  });
  const applied: { t: SurfaceTransform[]; f: Partial<SurfaceFilters>[] } = { t: [], f: [] };
  const surface = {
    kind: 'video',
    element: el,
    contentRect: new DOMRect(0, 0, 640, 360),
    colorInfo: { range: 'sdr', gamut: 'srgb' },
    setFit: () => undefined,
    setTransform: (t: SurfaceTransform) => void applied.t.push(t),
    setFilters: (f: Partial<SurfaceFilters>) => void applied.f.push(f),
    snapshot: () => Promise.reject(new Error('no')),
    onContentRectChange: () => () => undefined,
    destroy: () => undefined,
  } as unknown as Surface;
  return { surface, applied };
}

async function setup(inset = 0) {
  const { surface, applied } = fakeSurface();
  const core = createCore<PictureSliceState, PictureActionMap>({ slices: [PICTURE_SLICE], plugins: [createPicturePlugin({ surface: () => surface, controlsInset: () => inset })] });
  await core.start();
  return { core, applied, state: () => core.store.getState().picture };
}

describe('picture plugin', () => {
  it('zooms at a point, keeping that point under the pointer, within 1..8', async () => {
    const { core, state, applied } = await setup();
    core.store.dispatch('zoom-at', { factor: 2, x: 0.75, y: 0.5 });
    expect(state().zoom).toBe(2);
    // The picture moved left by a quarter of the box so x = 0.75 stays put.
    expect(state().pan[0]).toBeCloseTo(-0.25, 6);
    expect(state().pan[1]).toBeCloseTo(0, 6);
    // The surface gets pixels: a quarter of the 640 px box.
    expect(applied.t.at(-1)).toMatchObject({ zoom: 2, pan: [-160, 0] });
    for (let i = 0; i < 10; i++) core.store.dispatch('zoom-at', { factor: 2, x: 0.5, y: 0.5 });
    expect(state().zoom).toBe(ZOOM_MAX);
    for (let i = 0; i < 10; i++) core.store.dispatch('zoom-at', { factor: 0.5, x: 0.5, y: 0.5 });
    expect(state()).toMatchObject({ zoom: 1, pan: [0, 0] });
  });

  it('pans only while zoomed, never past the picture edge', async () => {
    const { core, state } = await setup();
    core.store.dispatch('pan-by', { dx: 0.3, dy: 0 });
    expect(state().pan).toEqual([0, 0]);
    core.store.dispatch('zoom-at', { factor: 2, x: 0.5, y: 0.5 });
    core.store.dispatch('pan-by', { dx: 5, dy: -5 });
    // 2x of a picture filling the box: half a box of room on each side.
    expect(state().pan[0]).toBeCloseTo(0.5, 6);
    expect(state().pan[1]).toBeCloseTo(-0.5, 6);
  });

  it('filters patch, reset restores everything', async () => {
    const { core, state, applied } = await setup();
    core.store.dispatch('set-filters', { filters: { brightness: 1.25, sharpen: 0.3 } });
    expect(state().filters).toMatchObject({ brightness: 1.25, contrast: 1, sharpen: 0.3 });
    expect(applied.f.at(-1)).toMatchObject({ brightness: 1.25, sharpen: 0.3 });
    core.store.dispatch('zoom-at', { factor: 3, x: 0.5, y: 0.5 });
    core.store.dispatch('reset-picture', {});
    expect(state()).toMatchObject({ zoom: 1, pan: [0, 0], filters: { brightness: 1, sharpen: 0 } });
  });

  it('zoomed, the picture works in the area above the controls', async () => {
    const { core, applied } = await setup(60);
    core.store.dispatch('zoom-at', { factor: 2, x: 0.5, y: 0.5 });
    expect(applied.t.at(-1)).toMatchObject({ zoom: 2, viewportBottom: 60 });
  });
});
