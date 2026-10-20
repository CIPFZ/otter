// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  computeContentRect,
  createVideoSurface,
  filterCss,
  IDENTITY_TRANSFORM,
  surfaceCss,
} from '@otter-player/surface';

const box = { width: 1000, height: 500 };
const hd = { width: 1920, height: 1080 };

describe('computeContentRect', () => {
  it('letterboxes with contain and crops with cover', () => {
    const contain = computeContentRect(box, hd, 'contain');
    expect(contain.width).toBeCloseTo(888.889, 3);
    expect(contain.height).toBe(500);
    expect(contain.x).toBeCloseTo(55.556, 3);
    expect(contain.y).toBe(0);
    const cover = computeContentRect(box, hd, 'cover');
    expect(cover.width).toBe(1000);
    expect(cover.height).toBeCloseTo(562.5);
    expect(cover.y).toBeCloseTo(-31.25);
  });

  it('handles fill, none, a forced ratio and unknown video size', () => {
    expect(computeContentRect(box, hd, 'fill')).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
    expect(computeContentRect(box, { width: 320, height: 180 }, 'none')).toEqual({ x: 340, y: 160, width: 320, height: 180 });
    expect(computeContentRect(box, hd, { ratio: 4 / 3 })).toMatchObject({ width: 500 * (4 / 3), height: 500 });
    expect(computeContentRect(box, { width: 0, height: 0 }, 'contain')).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
  });

  it('swaps the aspect for quarter turns and applies zoom around the centre plus pan', () => {
    const rotated = computeContentRect(box, hd, 'contain', { ...IDENTITY_TRANSFORM, rotate: 90 });
    expect(rotated.height).toBe(500);
    expect(rotated.width).toBeCloseTo(281.25);
    const zoomed = computeContentRect(box, hd, 'fill', { ...IDENTITY_TRANSFORM, zoom: 2, pan: [10, -5] });
    expect(zoomed).toEqual({ x: -500 + 10, y: -250 - 5, width: 2000, height: 1000 });
  });
});

describe('surfaceCss / filterCss', () => {
  it('scales the rotated picture so it still fits', () => {
    const css = surfaceCss(box, hd, 'contain', { ...IDENTITY_TRANSFORM, rotate: 90, mirror: true });
    expect(css.objectFit).toBe('contain');
    // Rendered contain picture is 888.9 x 500; rotated it must become 281.25 x 500.
    expect(css.transform).toBe('rotate(90deg) scale(0.5625, 0.5625) scaleX(-1)');
    expect(surfaceCss(box, hd, 'contain', IDENTITY_TRANSFORM).transform).toBe('');
    expect(surfaceCss(box, hd, { ratio: 1 }, IDENTITY_TRANSFORM)).toEqual({ objectFit: 'fill', transform: 'scale(0.5, 1)' });
  });

  it('maps CSS-capable filters only', () => {
    expect(filterCss({ brightness: 1.2, contrast: 1, saturate: 0, temperature: 0, sharpen: 0 })).toBe('brightness(1.2) saturate(0)');
  });
});

describe('createVideoSurface', () => {
  it('applies fit and transform to the element and reports the picture rect', () => {
    const video = document.createElement('video');
    const surface = createVideoSurface(video);
    const rects: DOMRectReadOnly[] = [];
    surface.onContentRectChange((r) => rects.push(r));
    surface.setFit('cover');
    expect(video.style.objectFit).toBe('cover');
    surface.setTransform({ ...IDENTITY_TRANSFORM, rotate: 180 });
    expect(video.style.transform).toBe('rotate(180deg)');
    expect(surface.kind).toBe('video');
    surface.destroy();
  });

  it('uses CSS shorthand filters when they suffice, an SVG filter (same matrix as GPUSurface) otherwise', async () => {
    const video = document.createElement('video');
    document.body.append(video);
    const surface = createVideoSurface(video);
    surface.setFilters({ contrast: 1.5 });
    expect(video.style.filter).toBe('contrast(1.5)');
    // The SVG filter is an on-demand chunk: a later shorthand-only change wins over a pending load.
    surface.setFilters({ sharpen: 0.4 });
    surface.setFilters({ sharpen: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(video.style.filter).toBe('contrast(1.5)');
    surface.setFilters({ sharpen: 0.4, temperature: 0.5 });
    await vi.waitFor(() => expect(video.style.filter).toMatch(/^url\("?#otter-filter-\d+"?\)$/));
    const filter = video.nextElementSibling?.querySelector('filter');
    expect(filter?.getAttribute('color-interpolation-filters')).toBe('sRGB');
    expect(filter?.querySelector('feConvolveMatrix')?.getAttribute('kernelMatrix')).toBe('0 -0.4 0 -0.4 2.6 -0.4 0 -0.4 0');
    surface.setFilters({ sharpen: 0, temperature: 0, contrast: 1 });
    expect(video.style.filter).toBe('');
    surface.destroy();
    await vi.waitFor(() => expect(video.nextElementSibling).toBeNull());
  });
});
