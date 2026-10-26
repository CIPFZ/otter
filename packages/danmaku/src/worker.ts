// Danmaku render Worker (ADR-012 §4): an OffscreenCanvas with the WebGL batch stage. The main
// thread keeps the timeline and the tracks (cheap) and sends, per frame, the comments that entered
// (to rasterise here) or left, and every running comment's position; text rasterisation, atlas
// uploads and drawing happen here, off the main thread.

import { createGlStage, type GlStage, type MaskSourceImage } from './gl-stage.js';
import { paintText, type Comment } from './renderer.js';

export type WorkerAdd = Pick<Comment, 'index' | 'text' | 'color' | 'px' | 'width' | 'height' | 'own'>;
export type WorkerMessage =
  | { readonly t: 'init'; readonly canvas: OffscreenCanvas }
  | { readonly t: 'resize'; readonly width: number; readonly height: number; readonly dpr: number }
  | {
      readonly t: 'frame';
      readonly add: readonly WorkerAdd[];
      readonly remove: readonly number[];
      readonly items: Float32Array;
      readonly count: number;
      /** A new mask (null: none), absent: unchanged. */
      readonly mask?: MaskSourceImage | null;
    };

let stage: GlStage | undefined;
let dpr = 1;
const scope = self as unknown as { onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null; postMessage(m: unknown): void };

scope.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'init') {
    stage = createGlStage(m.canvas);
    scope.postMessage(stage === undefined ? { t: 'error', reason: 'no WebGL2 in the Worker' } : { t: 'ready' });
    return;
  }
  if (stage === undefined) return;
  if (m.t === 'resize') {
    dpr = m.dpr;
    stage.resize(Math.round(m.width * m.dpr), Math.round(m.height * m.dpr));
    return;
  }
  if (m.mask !== undefined) {
    stage.setMask(m.mask);
    if (m.mask !== null && 'close' in m.mask) m.mask.close();
  }
  for (const id of m.remove) stage.remove(id);
  for (const a of m.add) {
    stage.paint(a.index, Math.max(1, Math.ceil(a.width * dpr)), Math.max(1, Math.ceil(a.height * dpr)), (ctx) =>
      paintText(ctx, { ...a, size: a.px, mode: 'rtl', time: 0, x: 0, y: 0, sprite: undefined }, 0, 0, dpr),
    );
  }
  // CSS px to whole device px.
  for (let i = 0; i < m.count; i++) {
    m.items[i * 3 + 1] = Math.round((m.items[i * 3 + 1] as number) * dpr);
    m.items[i * 3 + 2] = Math.round((m.items[i * 3 + 2] as number) * dpr);
  }
  stage.draw(m.items, m.count);
  scope.postMessage({ t: 'drawn' });
};
