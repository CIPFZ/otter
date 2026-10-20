// WebGL2 picture renderer for GPUSurface (SPEC §12, ADR-008 §6). One context draws any number of
// views (multi-view grids share it, staying under the browser's ~16 context limit). Sources:
// WebCodecs VideoFrame (or any TexImageSource) as an RGBA texture, or I420 planes from a WASM
// decoder as three R8 textures converted in the shader. Sharpen and the colour matrix use the
// numbers of filters.ts, so the picture matches VideoSurface's SVG filter. Works on an
// HTMLCanvasElement or an OffscreenCanvas (render worker).

import { colorMatrix } from './filters.js';
import type { SurfaceFilters, SurfaceTransform } from './surface.js';

/** Planar 4:2:0 picture: Y (width x height), then U and V (half size, rounded up). */
export interface I420Frame {
  readonly format: 'I420';
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Microseconds, like VideoFrame. */
  readonly timestamp: number;
  /** YUV -> RGB matrix (limited range); default BT.709 from 720 lines up, else BT.601. */
  readonly matrix?: 'bt601' | 'bt709';
}

/** What a frame sink accepts. */
export type SurfaceFrame = VideoFrame | I420Frame | ImageBitmap | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas;

export const isI420 = (f: SurfaceFrame): f is I420Frame => (f as Partial<I420Frame>).format === 'I420' && (f as Partial<I420Frame>).data instanceof Uint8Array;

/** Intrinsic size of a frame. */
export function frameSize(f: SurfaceFrame): { width: number; height: number } {
  if (isI420(f)) return { width: f.width, height: f.height };
  const v = f as Partial<VideoFrame & HTMLVideoElement & { width: number; height: number }>;
  if (typeof v.displayWidth === 'number') return { width: v.displayWidth, height: v.displayHeight ?? 0 };
  if (typeof v.videoWidth === 'number') return { width: v.videoWidth, height: v.videoHeight ?? 0 };
  return { width: v.width ?? 0, height: v.height ?? 0 };
}

/** Rectangle in device pixels, origin top-left of the canvas. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewDraw {
  /** Where the view sits (clears to black there; the picture is clipped to it). */
  readonly region: PixelRect;
  /** Where the picture lands after fit / zoom / pan (may extend beyond the region). */
  readonly content: PixelRect;
  readonly transform: SurfaceTransform;
  readonly filters: SurfaceFilters;
}

export interface GlRenderer {
  readonly gl: WebGL2RenderingContext;
  /** Uploads `frame` as view `id`'s picture (the caller keeps ownership of VideoFrames). */
  upload(id: number, frame: SurfaceFrame): void;
  /** Size of view `id`'s last uploaded picture, undefined before any. */
  size(id: number): { width: number; height: number } | undefined;
  forget(id: number): void;
  /** Draws the given views (views without a picture stay black). */
  render(canvasWidth: number, canvasHeight: number, views: ReadonlyMap<number, ViewDraw>): void;
  destroy(): void;
}

const VERTEX = `#version 300 es
in vec2 a_pos;
uniform vec4 u_rect;      // content rect in clip space: x, y (top-left), width, height
uniform mat3 u_uv;        // unit quad -> texture coordinates (rotation / mirror)
out vec2 v_uv;
void main() {
  v_uv = (u_uv * vec3(a_pos, 1.0)).xy;
  gl_Position = vec4(u_rect.x + a_pos.x * u_rect.z, u_rect.y - a_pos.y * u_rect.w, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_tex0;
uniform sampler2D u_tex1;
uniform sampler2D u_tex2;
uniform int u_yuv;
uniform mat3 u_yuvMatrix;
uniform mat3 u_color;     // colour matrix (filters.ts), column-major
uniform vec3 u_offset;
uniform float u_sharpen;
uniform vec2 u_step;      // one output pixel in texture units
in vec2 v_uv;
out vec4 o;
vec3 src(vec2 uv) {
  if (u_yuv == 1) {
    vec3 yuv = vec3(texture(u_tex0, uv).r - 0.0625, texture(u_tex1, uv).r - 0.5, texture(u_tex2, uv).r - 0.5);
    return u_yuvMatrix * yuv;
  }
  return texture(u_tex0, uv).rgb;
}
void main() {
  vec3 c = clamp(src(v_uv), 0.0, 1.0);
  if (u_sharpen > 0.0) {
    vec3 n = src(v_uv + vec2(u_step.x, 0.0)) + src(v_uv - vec2(u_step.x, 0.0)) + src(v_uv + vec2(0.0, u_step.y)) + src(v_uv - vec2(0.0, u_step.y));
    c = clamp(c * (1.0 + 4.0 * u_sharpen) - clamp(n, 0.0, 4.0) * u_sharpen, 0.0, 1.0);
  }
  o = vec4(clamp(u_color * c + u_offset, 0.0, 1.0), 1.0);
}`;

// Limited-range YUV -> RGB (column-major for GLSL): R = 1.164Y + kr V, ...
const BT709 = [1.164, 1.164, 1.164, 0, -0.213, 2.112, 1.793, -0.533, 0];
const BT601 = [1.164, 1.164, 1.164, 0, -0.392, 2.017, 1.596, -0.813, 0];

interface Picture {
  kind: 'rgba' | 'yuv';
  width: number;
  height: number;
  matrix: 'bt601' | 'bt709';
  tex: WebGLTexture[];
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const s = gl.createShader(type) as WebGLShader;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s) ?? ''}`);
  return s;
}

/**
 * Texture coordinates for the unit quad (x, y; y down) under rotate / mirror, as a column-major
 * mat3. Like VideoSurface's CSS (`rotate(θ) scaleX(-1)`, applied right to left): the picture is
 * mirrored first, then turned clockwise, so the quad samples the inverse of that.
 */
function uvMatrix(t: SurfaceTransform): number[] {
  // Columns: coefficient of x, coefficient of y, constant (for u, v, 1).
  const table: Record<SurfaceTransform['rotate'], [number[], number[]]> = {
    0: [[1, 0, 0, 0, 1, 0, 0, 0, 1], [-1, 0, 0, 0, 1, 0, 1, 0, 1]], // u = x | 1 - x, v = y
    90: [[0, -1, 0, 1, 0, 0, 0, 1, 1], [0, -1, 0, -1, 0, 0, 1, 1, 1]], // u = y | 1 - y, v = 1 - x
    180: [[-1, 0, 0, 0, -1, 0, 1, 1, 1], [1, 0, 0, 0, -1, 0, 0, 1, 1]], // u = 1 - x | x, v = 1 - y
    270: [[0, 1, 0, -1, 0, 0, 1, 0, 1], [0, 1, 0, 1, 0, 0, 0, 0, 1]], // u = 1 - y | y, v = x
  };
  return table[t.rotate][t.mirror ? 1 : 0] as number[];
}

export function createGlRenderer(canvas: HTMLCanvasElement | OffscreenCanvas): GlRenderer | undefined {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
  if (gl === null) return undefined;
  const program = gl.createProgram() as WebGLProgram;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program) ?? ''}`);
  gl.useProgram(program);
  const at = (n: string): WebGLUniformLocation | null => gl.getUniformLocation(program, n);
  const u = {
    rect: at('u_rect'),
    uv: at('u_uv'),
    yuv: at('u_yuv'),
    yuvMatrix: at('u_yuvMatrix'),
    color: at('u_color'),
    offset: at('u_offset'),
    sharpen: at('u_sharpen'),
    step: at('u_step'),
  };
  gl.uniform1i(at('u_tex0'), 0);
  gl.uniform1i(at('u_tex1'), 1);
  gl.uniform1i(at('u_tex2'), 2);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const pictures = new Map<number, Picture>();
  const newTexture = (): WebGLTexture => {
    const t = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  const picture = (id: number, kind: Picture['kind']): Picture => {
    let p = pictures.get(id);
    if (p !== undefined && p.kind !== kind) {
      for (const t of p.tex) gl.deleteTexture(t);
      p = undefined;
    }
    if (p === undefined) {
      p = { kind, width: 0, height: 0, matrix: 'bt709', tex: kind === 'yuv' ? [newTexture(), newTexture(), newTexture()] : [newTexture()] };
      pictures.set(id, p);
    }
    return p;
  };

  return {
    gl,
    upload(id, frame) {
      if (isI420(frame)) {
        const p = picture(id, 'yuv');
        const { width: w, height: h, data } = frame;
        const cw = (w + 1) >> 1;
        const ch = (h + 1) >> 1;
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const planes: [number, number, number][] = [
          [0, w, h],
          [w * h, cw, ch],
          [w * h + cw * ch, cw, ch],
        ];
        // Same size as the last picture: update the textures in place (no reallocation).
        const same = p.width === w && p.height === h;
        planes.forEach(([offset, pw, ph], i) => {
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, p.tex[i] as WebGLTexture);
          const plane = data.subarray(offset, offset + pw * ph);
          if (same) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pw, ph, gl.RED, gl.UNSIGNED_BYTE, plane);
          else gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, pw, ph, 0, gl.RED, gl.UNSIGNED_BYTE, plane);
        });
        p.width = w;
        p.height = h;
        p.matrix = frame.matrix ?? (h >= 720 ? 'bt709' : 'bt601');
        return;
      }
      const p = picture(id, 'rgba');
      const size = frameSize(frame);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, p.tex[0] as WebGLTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame as TexImageSource);
      p.width = size.width;
      p.height = size.height;
    },
    size: (id) => {
      const p = pictures.get(id);
      return p === undefined || p.width === 0 ? undefined : { width: p.width, height: p.height };
    },
    forget(id) {
      const p = pictures.get(id);
      if (p !== undefined) for (const t of p.tex) gl.deleteTexture(t);
      pictures.delete(id);
    },
    render(W, H, views) {
      gl.viewport(0, 0, W, H);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      for (const [id, v] of views) {
        const p = pictures.get(id);
        const r = v.region;
        // Scissor's origin is bottom-left.
        gl.scissor(Math.round(r.x), Math.round(H - r.y - r.height), Math.round(r.width), Math.round(r.height));
        if (p === undefined || p.width === 0 || v.content.width <= 0 || v.content.height <= 0) continue;
        p.tex.forEach((t, i) => {
          gl.activeTexture(gl.TEXTURE0 + i);
          gl.bindTexture(gl.TEXTURE_2D, t);
        });
        const c = v.content;
        gl.uniform4f(u.rect, (c.x / W) * 2 - 1, 1 - (c.y / H) * 2, (c.width / W) * 2, (c.height / H) * 2);
        gl.uniformMatrix3fv(u.uv, false, uvMatrix(v.transform));
        gl.uniform1i(u.yuv, p.kind === 'yuv' ? 1 : 0);
        gl.uniformMatrix3fv(u.yuvMatrix, false, p.matrix === 'bt601' ? BT601 : BT709);
        const m = colorMatrix(v.filters);
        // Row-major 3x4 -> column-major mat3 + offset.
        gl.uniformMatrix3fv(u.color, false, [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]);
        gl.uniform3f(u.offset, m[3], m[7], m[11]);
        gl.uniform1f(u.sharpen, Math.max(0, v.filters.sharpen));
        const turned = v.transform.rotate === 90 || v.transform.rotate === 270;
        gl.uniform2f(u.step, 1 / (turned ? c.height : c.width), 1 / (turned ? c.width : c.height));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      gl.disable(gl.SCISSOR_TEST);
    },
    destroy() {
      for (const p of pictures.values()) for (const t of p.tex) gl.deleteTexture(t);
      pictures.clear();
      gl.deleteProgram(program);
      gl.deleteBuffer(buf);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
