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
    rects: () => Object.fromEntries(Object.entries(surfaces).map(([k, s]) => [k, { x: s.contentRect.x, y: s.contentRect.y, width: s.contentRect.width, height: s.contentRect.height }])),
  };
}

window.surfaces = start();
