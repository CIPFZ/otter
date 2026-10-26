// The main-thread side of the danmaku render Worker (ADR-012 §4), an on-demand chunk: the stage
// canvas goes to the Worker (transferControlToOffscreen); comments that enter or leave and the
// positions of the running ones go there once per frame. A frame waits while the Worker is still
// drawing the previous one (the newest positions win).

import type { Comment, DanmakuRenderer } from './renderer.js';
import type { WorkerAdd, WorkerMessage } from './worker.js';

/** A transferable copy of an OffscreenCanvas mask (its own content stays for reuse). */
function copyBitmap(c: OffscreenCanvas): ImageBitmap {
  const copy = new OffscreenCanvas(c.width, c.height);
  (copy.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(c, 0, 0);
  return copy.transferToImageBitmap();
}

export function createWorkerRenderer(doc: Document, onError: (reason: string) => void): DanmakuRenderer | undefined {
  const canvas = doc.createElement('canvas');
  if (typeof canvas.transferControlToOffscreen !== 'function' || typeof Worker !== 'function') return undefined;
  canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%';
  const offscreen = canvas.transferControlToOffscreen();
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const post = (m: WorkerMessage, transfer: Transferable[] = []): void => worker.postMessage(m, transfer);
  post({ t: 'init', canvas: offscreen }, [offscreen]);
  let busy = false;
  let add: WorkerAdd[] = [];
  let remove: number[] = [];
  let maskVersion = -1;
  /** When each frame in flight was posted (the Worker answers in order). */
  const posted: number[] = [];
  /**
   * Post -> drawn in the Worker, one way (the reply's own wait on a busy main thread is not
   * display latency): the median of the last 15 frames (one slow draw does not move it).
   */
  const draws: number[] = [];
  let drawMs = 8;
  worker.onmessage = (e: MessageEvent<{ t: string; reason?: string; at?: number }>) => {
    if (e.data.t === 'drawn') {
      busy = false;
      const at = posted.shift();
      if (at !== undefined && e.data.at !== undefined) {
        draws.push(Math.max(0, e.data.at - performance.timeOrigin - at));
        if (draws.length > 15) draws.shift();
        drawMs = [...draws].sort((a, b) => a - b)[draws.length >> 1] as number;
      }
    }
    else if (e.data.t === 'error') onError(e.data.reason ?? 'Worker failed');
  };
  worker.onerror = () => onError('Worker failed to start');
  return {
    kind: 'worker',
    element: canvas,
    // Drawn in the Worker, then one more display frame until its canvas is composited.
    get latencyMs() {
      return drawMs + 16.7;
    },
    resize(width, height, dpr) {
      post({ t: 'resize', width, height, dpr });
    },
    prepare(c: Comment) {
      add.push({ index: c.index, text: c.text, color: c.color, px: c.px, width: c.width, height: c.height, own: c.own });
      c.sprite = true;
    },
    release(c: Comment) {
      if (c.sprite === true) remove.push(c.index);
      c.sprite = undefined;
    },
    draw(running, mask) {
      const v = mask?.version ?? -1;
      if (busy && add.length === 0 && remove.length === 0 && v === maskVersion) return;
      const items = new Float32Array(running.length * 3);
      running.forEach((c, i) => {
        items[i * 3] = c.index;
        items[i * 3 + 1] = c.x;
        items[i * 3 + 2] = c.y;
      });
      busy = true;
      posted.push(performance.now());
      // A changed mask goes over as a bitmap (a copy of the mask canvas, transferred).
      let bitmap: ImageBitmap | null | undefined;
      if (v !== maskVersion) {
        maskVersion = v;
        const c = mask?.canvas;
        bitmap = c === undefined ? null : 'transferToImageBitmap' in c ? copyBitmap(c) : null;
      }
      post({ t: 'frame', add, remove, items, count: running.length, ...(bitmap === undefined ? {} : { mask: bitmap }) }, bitmap ? [items.buffer, bitmap] : [items.buffer]);
      add = [];
      remove = [];
    },
    destroy() {
      worker.terminate();
      canvas.remove();
    },
  };
}
