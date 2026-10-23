// SDR colour management for the frame surfaces (ADR-011 §3). Where the platform shows <video>
// colour-managed (WebKit; Chromium compositing on the GPU), an untagged SD picture is taken as
// SMPTE 170M and its primaries are converted to the display's sRGB; GPUSurface / CanvasSurface
// must do the same or the same stream looks different on a canvas. The numbers: linear light
// through the sRGB curve both ways, primaries matrices from the chromaticities (D65), which
// reproduces Edge's <video> to the unit (red bar 253,0,1 -> 246,36,0). SDR only: no PQ / HLG.

import type { I420Frame, SurfaceFrame } from './gl-renderer.js';

/** Linear-light RGB in the given primaries -> BT.709 / sRGB primaries, row-major. */
const TO_SRGB: Record<string, readonly number[]> = {
  smpte170m: [0.93954, 0.05018, 0.01028, 0.01777, 0.96579, 0.01643, -0.00162, -0.00437, 1.00599],
  bt470bg: [1.04404, -0.04404, 0, 0, 1, 0, 0, 0.01179, 0.98821],
};

/** Picture height from which an untagged picture is HD (BT.709), like decoders guess. */
const HD_LINES = 720;

/** YUV -> RGB of an I420 picture, from its tags or, untagged, its height. */
export const i420Matrix = (f: I420Frame): 'bt601' | 'bt709' => f.matrix ?? (f.height >= HD_LINES ? 'bt709' : 'bt601');

/**
 * Primaries of a frame: its tag, or for an untagged YUV picture the decoders' guess from the
 * height (SD SMPTE 170M, HD BT.709). An RGB frame without a tag is already display-referred.
 */
export function framePrimaries(f: SurfaceFrame): string | undefined {
  if ((f as Partial<I420Frame>).format === 'I420' && (f as Partial<I420Frame>).data instanceof Uint8Array) {
    const i = f as I420Frame;
    return i.primaries ?? (i420Matrix(i) === 'bt601' ? 'smpte170m' : 'bt709');
  }
  const v = f as Partial<VideoFrame>;
  if (v.colorSpace === undefined) return undefined;
  if (v.colorSpace.primaries != null) return v.colorSpace.primaries;
  return v.format != null && /^(I4|NV)/.test(v.format) ? ((v.displayHeight ?? 0) >= HD_LINES ? 'bt709' : 'smpte170m') : undefined;
}

/** Row-major primaries matrix to sRGB, or undefined when there is nothing to convert. */
export const gamutMatrix = (primaries: string | undefined): readonly number[] | undefined => (primaries === undefined ? undefined : TO_SRGB[primaries]);

/**
 * YUV -> RGB as a column-major mat3 (columns Y, U, V) plus the offsets to subtract first, for
 * BT.601 / BT.709 coefficients and limited / full range.
 */
export function yuvMatrix(matrix: 'bt601' | 'bt709', fullRange: boolean): { m: number[]; offset: [number, number, number] } {
  const [kr, kb] = matrix === 'bt709' ? [0.2126, 0.0722] : [0.299, 0.114];
  const kg = 1 - kr - kb;
  const y = fullRange ? 1 : 255 / 219;
  const c = fullRange ? 1 : 255 / 224;
  const u = 2 * (1 - kb) * c;
  const v = 2 * (1 - kr) * c;
  return { m: [y, y, y, 0, (-u * kb) / kg, u, v, (-v * kr) / kg, 0], offset: [fullRange ? 0 : 16 / 255, 128 / 255, 128 / 255] };
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * Whether this platform shows <video> colour-managed: yes on the GPU; Chromium's software
 * compositor (SwiftShader, headless) and software GL draw video unconverted.
 */
export function platformManagesVideo(gl: WebGLRenderingContext | WebGL2RenderingContext | null): boolean {
  if (gl === null) return false;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return !SOFTWARE.test(String(gl.getParameter(info === null ? gl.RENDERER : info.UNMASKED_RENDERER_WEBGL)));
}

/** A 2x2 red picture tagged SMPTE 170M: drawn by a path that converts, green comes out ~36. */
export const probeFrame = (): VideoFrame =>
  new VideoFrame(new Uint8Array([81, 81, 81, 81, 90, 240]), {
    format: 'I420',
    codedWidth: 2,
    codedHeight: 2,
    timestamp: 0,
    colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false },
  });

/** Green of the probe frame as a path drew it: the path converts primaries itself. */
export const probeConverted = (green: number): boolean => green > 16;
