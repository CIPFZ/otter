// The WebGL stage's sprite path (M6 F4): a comment is painted on its own OffscreenCanvas and
// uploaded from it, with no CPU readback (getImageData in a Worker that draws WebGL to a
// transferred canvas stalls Firefox's page for ~10 s). A fake WebGL2 context records the uploads.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGlStage } from '../src/gl-stage.js';

const uploads: unknown[] = [];
let readbacks = 0;

class FakeCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(type: string): unknown {
    if (type === '2d') {
      // A 2D context whose drawing calls are no-ops; getImageData is counted.
      const ctx: Record<string, unknown> = {
        canvas: this,
        getImageData: () => {
          readbacks++;
          return { width: this.width, height: this.height };
        },
      };
      return new Proxy(ctx, { get: (t, k) => (k in t ? t[k as string] : () => undefined) });
    }
    if (type !== 'webgl2') return null;
    const gl: Record<string, unknown> = {
      MAX_TEXTURE_SIZE: 0x0d33,
      getParameter: (p: number) => (p === 0x0d33 ? 4096 : 0),
      getProgramParameter: () => true,
      getUniformLocation: () => ({}),
      getAttribLocation: () => 0,
      texSubImage2D: (...a: unknown[]) => uploads.push(a[6]),
    };
    return new Proxy(gl, { get: (t, k) => (k in t ? t[k as string] : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})) });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  uploads.length = 0;
  readbacks = 0;
});

describe('WebGL stage sprites', () => {
  it('paints each sprite on its own canvas and uploads it without reading pixels back (M6 F4)', () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const stage = createGlStage(new FakeCanvas(640, 360) as unknown as OffscreenCanvas);
    expect(stage).toBeDefined();
    let painted: unknown;
    expect(stage?.paint(1, 120, 32, (ctx) => (painted = ctx.canvas))).toBe(true);
    expect(stage?.paint(2, 80, 24, () => undefined)).toBe(true);
    expect(readbacks).toBe(0);
    expect(uploads).toHaveLength(2);
    // The upload source is the canvas the sprite was painted on, at its own size.
    expect(uploads[0]).toBe(painted);
    expect(uploads[0]).toMatchObject({ width: 120, height: 32 });
    expect(uploads[1]).toMatchObject({ width: 80, height: 24 });
  });
});
