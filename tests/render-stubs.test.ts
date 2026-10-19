// Contract tests for render-layer M0 empty implementations (node environment, no DOM).

import { describe, expect, it } from 'vitest';
import { createCore } from '@otter-player/core';
import { createDanmakuOverlay } from '@otter-player/danmaku';
import {
  createInputController,
  DEFAULT_GESTURES,
  DEFAULT_HOTKEYS,
  type InputActionMap,
} from '@otter-player/input';
import { createAdsOverlay } from '@otter-player/overlay-ads';
import { createThumbnailsOverlay } from '@otter-player/overlay-thumbnails';
import { createWatermarkOverlay } from '@otter-player/overlay-watermark';
import { createCanvasSurface, createGPUSurface, ZERO_RECT } from '@otter-player/surface';
import { createTextOverlay } from '@otter-player/text';
import { createAssOverlay } from '@otter-player/text-ass';
import { defineUIFeature, OTTER_ELEMENTS } from '@otter-player/ui-core';

const notImplemented = { type: 'other', details: 'notImplemented', fatal: false };
// Stubs never touch the element, so a placeholder object is enough without a DOM.
const fakeElement = <T>(): T => ({}) as T;

describe('surface', () => {
  it.each([
    ['canvas2d', () => createCanvasSurface(fakeElement<HTMLCanvasElement>())],
    ['gpu', () => createGPUSurface(fakeElement<HTMLCanvasElement>())],
  ] as const)('%s surface', async (kind, create) => {
    const surface = create();
    expect(surface.kind).toBe(kind);
    expect(surface.contentRect).toBe(ZERO_RECT);
    expect(surface.colorInfo).toEqual({ range: 'sdr', gamut: 'srgb' });
    expect(() => surface.setFit('contain')).toThrow(expect.objectContaining(notImplemented));
    await expect(surface.snapshot()).rejects.toMatchObject(notImplemented);
    surface.onContentRectChange(() => undefined)();
  });
});

describe('overlays', () => {
  it.each([
    ['danmaku', createDanmakuOverlay],
    ['text', createTextOverlay],
    ['text-ass', createAssOverlay],
    ['thumbnails', createThumbnailsOverlay],
    ['watermark', createWatermarkOverlay],
    ['ads', createAdsOverlay],
  ] as const)('%s overlay', (id, create) => {
    const overlay = create();
    expect(overlay.id).toBe(id);
    expect(Number.isFinite(overlay.zIndex)).toBe(true);
    overlay.destroy();
  });

  it('overlay ids and z-indexes are unique', () => {
    const all = [
      createDanmakuOverlay(),
      createTextOverlay(),
      createAssOverlay(),
      createThumbnailsOverlay(),
      createWatermarkOverlay(),
      createAdsOverlay(),
    ];
    expect(new Set(all.map((o) => o.id)).size).toBe(all.length);
    expect(new Set(all.map((o) => o.zIndex)).size).toBe(all.length);
  });
});

describe('input', () => {
  it('default mapping covers SPEC §14.3', () => {
    expect(DEFAULT_HOTKEYS[' ']).toEqual({ type: 'toggle-paused' });
    expect(DEFAULT_HOTKEYS['l']).toEqual({ type: 'seek-by', seconds: 10 });
    expect(DEFAULT_HOTKEYS['5']).toEqual({ type: 'seek-to-percent', percent: 50 });
    expect(DEFAULT_GESTURES.tap).toEqual({ type: 'toggle-controls' });
    expect(DEFAULT_GESTURES['long-press']).toEqual({ type: 'hold-rate', rate: 2 });
  });

  it('controller keeps remapped hotkeys', () => {
    const core = createCore<object, InputActionMap>();
    const input = createInputController({ store: core.store.view() });
    expect(input.hotkeys).toBe(DEFAULT_HOTKEYS);
    input.setHotkeys({ x: { type: 'toggle-pip' } });
    expect(input.hotkeys).toEqual({ x: { type: 'toggle-pip' } });
  });
});

describe('ui-core', () => {
  it('element names use the otter- prefix', () => {
    for (const tag of Object.values(OTTER_ELEMENTS)) expect(tag).toMatch(/^otter-[a-z-]+$/);
  });

  it('defineUIFeature keeps the definition', () => {
    const feature = defineUIFeature({ id: 'captions', overlays: [createTextOverlay()] });
    expect(feature.id).toBe('captions');
  });
});
