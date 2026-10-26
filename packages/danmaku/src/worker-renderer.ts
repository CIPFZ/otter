// The main-thread side of the danmaku render Worker (ADR-012 §4), an on-demand chunk: the stage
// canvas goes to the Worker (transferControlToOffscreen); comments that enter or leave and the
// positions of the running ones go there once per frame. A frame waits while the Worker is still
// drawing the previous one (the newest positions win).

import type { Comment, DanmakuRenderer } from './renderer.js';
import type { WorkerAdd, WorkerMessage } from './worker.js';

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
  worker.onmessage = (e: MessageEvent<{ t: string; reason?: string }>) => {
    if (e.data.t === 'drawn') busy = false;
    else if (e.data.t === 'error') onError(e.data.reason ?? 'Worker failed');
  };
  worker.onerror = () => onError('Worker failed to start');
  return {
    kind: 'worker',
    element: canvas,
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
    draw(running) {
      if (busy && add.length === 0 && remove.length === 0) return;
      const items = new Float32Array(running.length * 3);
      running.forEach((c, i) => {
        items[i * 3] = c.index;
        items[i * 3 + 1] = c.x;
        items[i * 3 + 2] = c.y;
      });
      busy = true;
      post({ t: 'frame', add, remove, items, count: running.length }, [items.buffer]);
      add = [];
      remove = [];
    },
    destroy() {
      worker.terminate();
      canvas.remove();
    },
  };
}
