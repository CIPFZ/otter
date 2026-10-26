// WebGL batch renderer for danmaku on the main thread (ADR-012 §4), an on-demand chunk: comment
// pictures in one atlas texture, one draw call per frame. Helpers of the main chunk are handed
// over (a value import of them would make a shared, eagerly loaded chunk).

import { createGlStage } from './gl-stage.js';
import type { Comment, DanmakuRenderer, paintText as PaintText } from './renderer.js';

export function createWebGlRenderer(doc: Document, paintText: typeof PaintText): DanmakuRenderer | undefined {
  const canvas = doc.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%';
  const stage = createGlStage(canvas);
  if (stage === undefined) return undefined;
  let dpr = 1;
  let items = new Float32Array(3 * 256);
  let maskVersion = -1;
  return {
    kind: 'webgl',
    element: canvas,
    resize(w, h, ratio) {
      dpr = ratio;
      stage.resize(Math.round(w * ratio), Math.round(h * ratio));
    },
    prepare(c: Comment) {
      c.sprite = stage.paint(c.index, Math.max(1, Math.ceil(c.width * dpr)), Math.max(1, Math.ceil(c.height * dpr)), (ctx) => paintText(ctx, c, 0, 0, dpr));
    },
    release(c: Comment) {
      if (c.sprite === true) stage.remove(c.index);
      c.sprite = undefined;
    },
    draw(running, mask) {
      const v = mask?.version ?? -1;
      if (v !== maskVersion) {
        maskVersion = v;
        stage.setMask(mask?.canvas ?? null);
      }
      if (items.length < running.length * 3) items = new Float32Array(Math.ceil(running.length * 1.5) * 3);
      running.forEach((c, i) => {
        items[i * 3] = c.index;
        items[i * 3 + 1] = Math.round(c.x * dpr);
        items[i * 3 + 2] = Math.round(c.y * dpr);
      });
      stage.draw(items, running.length);
    },
    destroy() {
      stage.destroy();
      canvas.remove();
    },
  };
}
