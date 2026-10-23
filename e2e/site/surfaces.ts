// Surfaces fixture (ADR-008 §6): one paused frame on VideoSurface, GPUSurface and CanvasSurface,
// so e2e can compare fit / zoom / rotation / filters pixel by pixel.

import { createVideoSurface, IDENTITY_TRANSFORM, NEUTRAL_FILTERS, type Surface, type SurfaceFilters, type SurfaceTransform } from '@otter-player/surface';
import { createCanvasSurface, createGPUSurface, type FrameSurface } from '@otter-player/surface/gpu';

export interface SurfacesFixture {
  /** Seeks the video to `time` and draws that frame on the frame surfaces. */
  frame(time: number): Promise<void>;
  apply(transform: Partial<SurfaceTransform>, filters: Partial<SurfaceFilters>): Promise<void>;
  /** Seeks the video only (the frame surfaces keep their frame). */
  seekVideo(time: number): Promise<void>;
  /**
   * Whether the platform colour-manages <video> / 2D canvas drawing but not WebGL texture uploads
   * of the same frame (WebKit): the same pixels through both paths, compared.
   */
  colourManaged(): ColourProbe;
  rects(): Record<string, { x: number; y: number; width: number; height: number }>;
  readonly gpu: boolean;
}

declare global {
  interface Window {
    surfaces?: Promise<SurfacesFixture>;
  }
}

const nextFrames = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * Seeks and waits until the new frame is presented: WebKit fires `seeked` before the element
 * shows (and VideoFrame(video) captures) the frame at the new time.
 */
export async function seekPresented(video: HTMLVideoElement, time: number): Promise<void> {
  const presented =
    typeof video.requestVideoFrameCallback === 'function'
      ? new Promise<void>((r) => video.requestVideoFrameCallback(() => r()))
      : Promise.resolve();
  const seeked = new Promise((r) => video.addEventListener('seeked', r, { once: true }));
  video.currentTime = time;
  await seeked;
  // A paused element presents one frame after a seek; do not hang if a browser skips the callback.
  await Promise.race([presented, new Promise((r) => setTimeout(r, 1000))]);
  await nextFrames();
}

export interface ColourProbe {
  managed: boolean;
  canvas2d: number[];
  webgl: number[];
  /** What the platform says about the frame: VideoFrame(video).colorSpace and format. */
  frame: { colorSpace: VideoColorSpaceInit; format: string | null };
  renderer: string | null;
  /** A synthetic red I420 frame tagged SMPTE 170M, through 2D and WebGL (converted or not). */
  synthetic: { canvas2d: number[]; webgl: number[] };
}

/** RGB of a 4x4 red I420 frame tagged SMPTE 170M, drawn by `path`. */
function syntheticRed(path: '2d' | 'webgl'): number[] {
  const data = new Uint8Array(16 + 4 + 4);
  data.fill(81, 0, 16);
  data.fill(90, 16, 20);
  data.fill(240, 20, 24);
  const frame = new VideoFrame(data, { format: 'I420', codedWidth: 4, codedHeight: 4, timestamp: 0, colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false } });
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  try {
    if (path === '2d') {
      const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
      ctx.drawImage(frame, 0, 0);
      return Array.from(ctx.getImageData(1, 1, 1, 1).data.slice(0, 3));
    }
    const gl = c.getContext('webgl2');
    if (gl === null) return [];
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const b = new Uint8Array(4 * 4 * 4);
    gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, b);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return Array.from(b.slice(20, 23));
  } finally {
    frame.close();
  }
}

/** Mean RGB of the frame through a 2D canvas and through a WebGL2 texture (no shader maths). */
function colourManaged(video: HTMLVideoElement): ColourProbe {
  const W = 64;
  const H = 36;
  const c2 = document.createElement('canvas');
  c2.width = W;
  c2.height = H;
  const ctx = c2.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.drawImage(video, 0, 0, W, H);
  const a = ctx.getImageData(0, 0, W, H).data;
  const cg = document.createElement('canvas');
  cg.width = W;
  cg.height = H;
  const gl = cg.getContext('webgl2');
  const frame = new VideoFrame(video);
  const info = { colorSpace: frame.colorSpace.toJSON(), format: frame.format };
  const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
  const renderer = gl !== null && dbg != null ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
  const synthetic = { canvas2d: syntheticRed('2d'), webgl: syntheticRed('webgl') };
  if (gl === null) {
    frame.close();
    return { managed: false, canvas2d: [], webgl: [], frame: info, renderer, synthetic };
  }
  // Upload, attach to a framebuffer and read back: the texture's own values.
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  frame.close();
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const w = video.videoWidth;
  const h = video.videoHeight;
  const b = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  // Compare the saturated colour bars: mean of the top-left-to-right row band, as RGB.
  const meanOf = (d: Uint8Array | Uint8ClampedArray, width: number, height: number, flipY: boolean): number[] => {
    const sum = [0, 0, 0];
    let n = 0;
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 64))) {
      const y = Math.floor(height * 0.6);
      const row = flipY ? height - 1 - y : y;
      for (let ch = 0; ch < 3; ch++) sum[ch] = (sum[ch] as number) + (d[(row * width + x) * 4 + ch] as number);
      n++;
    }
    return sum.map((v) => v / n);
  };
  const canvas2d = meanOf(a, W, H, false);
  // A framebuffer-attached texture uploaded from a frame is read bottom-up relative to the image
  // only when UNPACK_FLIP_Y is set; it is not, so rows match the image.
  const webgl = meanOf(b, w, h, false);
  const managed = canvas2d.some((v, i) => Math.abs(v - (webgl[i] as number)) > 4);
  return { managed, canvas2d, webgl, frame: info, renderer, synthetic };
}

async function start(): Promise<SurfacesFixture> {
  const video = document.querySelector('video') as HTMLVideoElement;
  const surfaces: Record<string, Surface> = { video: createVideoSurface(video) };
  let gpu: FrameSurface | undefined;
  try {
    gpu = createGPUSurface(document.getElementById('gpu') as HTMLCanvasElement);
    surfaces['gpu'] = gpu;
  } catch {
    // No WebGL2 (headless Firefox): the GPU box stays black and is skipped.
  }
  const canvas2d = createCanvasSurface(document.getElementById('canvas2d') as HTMLCanvasElement);
  surfaces['canvas2d'] = canvas2d;
  if (video.readyState < 1) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  let transform: SurfaceTransform = IDENTITY_TRANSFORM;
  let filters: SurfaceFilters = NEUTRAL_FILTERS;
  return {
    gpu: gpu !== undefined,
    async frame(time) {
      await seekPresented(video, time);
      gpu?.draw(new VideoFrame(video));
      canvas2d.draw(new VideoFrame(video));
      await nextFrames();
    },
    async apply(t, f) {
      transform = { ...transform, ...t };
      filters = { ...filters, ...f };
      for (const s of Object.values(surfaces)) {
        s.setTransform(transform);
        s.setFilters(filters);
      }
      // Temperature / sharpen load the SVG filter chunk first (on demand): wait until VideoSurface
      // uses it; the frame surfaces share the same module and redraw when it is there.
      if (filters.temperature !== 0 || filters.sharpen !== 0) {
        while (!video.style.filter.startsWith('url(')) await nextFrames();
      }
      await nextFrames();
    },
    seekVideo: (time) => seekPresented(video, time),
    colourManaged: () => colourManaged(video),
    rects: () => Object.fromEntries(Object.entries(surfaces).map(([k, s]) => [k, { x: s.contentRect.x, y: s.contentRect.y, width: s.contentRect.width, height: s.contentRect.height }])),
  };
}

window.surfaces = start();
