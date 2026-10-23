import { describe, expect, it } from 'vitest';
import { framePrimaries, gamutMatrix, platformManagesVideo, probeConverted, yuvMatrix } from '../src/color.js';
import type { I420Frame } from '../src/gl-renderer.js';

const enc = (l: number): number => {
  const c = Math.min(1, Math.max(0, l));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};
const dec = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** The shader's conversion, in 0..255. */
const convert = (m: readonly number[], rgb: number[]): number[] => {
  const l = rgb.map((v) => dec(v / 255));
  return [0, 1, 2].map((r) => Math.round(enc((m[r * 3] as number) * (l[0] as number) + (m[r * 3 + 1] as number) * (l[1] as number) + (m[r * 3 + 2] as number) * (l[2] as number)) * 255));
};
const i420 = (height: number, extra: Partial<I420Frame> = {}): I420Frame => ({ format: 'I420', width: 16, height, data: new Uint8Array(4), timestamp: 0, ...extra });

describe('SDR colour management (ADR-011 §3)', () => {
  it('SMPTE 170M -> sRGB reproduces Edge <video> on the colour bars', () => {
    const m = gamutMatrix('smpte170m') as readonly number[];
    // Measured on Edge (Windows, GPU): the surface's unconverted bar -> what <video> shows.
    const bars: [number[], number[]][] = [
      [[253, 0, 1], [246, 36, 0]],
      [[9, 255, 4], [65, 251, 0]],
      [[0, 0, 253], [26, 34, 254]],
      [[0, 255, 255], [70, 253, 255]],
    ];
    for (const [from, to] of bars) expect(convert(m, from)).toEqual(to);
  });

  it('BT.709 needs no conversion; unknown primaries are left alone', () => {
    expect(gamutMatrix('bt709')).toBeUndefined();
    expect(gamutMatrix(undefined)).toBeUndefined();
    expect(gamutMatrix('bt2020')).toBeUndefined();
  });

  it('primaries: the tag, else SD SMPTE 170M / HD BT.709 for YUV, nothing for untagged RGB', () => {
    expect(framePrimaries(i420(360))).toBe('smpte170m');
    expect(framePrimaries(i420(720))).toBe('bt709');
    expect(framePrimaries(i420(360, { primaries: 'bt470bg' }))).toBe('bt470bg');
    expect(framePrimaries(i420(1080, { matrix: 'bt601' }))).toBe('smpte170m');
    const frame = (format: string, primaries: string | null, displayHeight = 360) => ({ format, displayHeight, colorSpace: { primaries } }) as unknown as VideoFrame;
    expect(framePrimaries(frame('NV12', 'smpte170m', 1080))).toBe('smpte170m');
    expect(framePrimaries(frame('I420', null))).toBe('smpte170m');
    expect(framePrimaries(frame('I420', null, 720))).toBe('bt709');
    expect(framePrimaries(frame('BGRA', null))).toBeUndefined();
    expect(framePrimaries({ width: 2, height: 2 } as unknown as ImageBitmap)).toBeUndefined();
  });

  it('YUV matrices: BT.601 / BT.709 coefficients, limited and full range', () => {
    const round = (xs: number[]) => xs.map((x) => Math.round(x * 1000) / 1000);
    expect(round(yuvMatrix('bt601', false).m)).toEqual([1.164, 1.164, 1.164, 0, -0.392, 2.017, 1.596, -0.813, 0]);
    expect(round(yuvMatrix('bt709', false).m)).toEqual([1.164, 1.164, 1.164, 0, -0.213, 2.112, 1.793, -0.533, 0]);
    expect(round(yuvMatrix('bt601', true).m)).toEqual([1, 1, 1, 0, -0.344, 1.772, 1.402, -0.714, 0]);
    expect(yuvMatrix('bt709', true).offset[0]).toBe(0);
    expect(yuvMatrix('bt709', false).offset[0]).toBeCloseTo(16 / 255);
  });

  it('software rendering does not colour-manage video', () => {
    const gl = (renderer: string) => ({ RENDERER: 1, getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 2 }), getParameter: () => renderer }) as unknown as WebGL2RenderingContext;
    expect(platformManagesVideo(gl('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'))).toBe(false);
    expect(platformManagesVideo(gl('llvmpipe (LLVM 15.0.7, 256 bits)'))).toBe(false);
    expect(platformManagesVideo(gl('ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)'))).toBe(true);
    expect(platformManagesVideo(gl('Apple GPU'))).toBe(true);
    expect(platformManagesVideo(null)).toBe(false);
    expect(probeConverted(36)).toBe(true);
    expect(probeConverted(0)).toBe(false);
  });
});
