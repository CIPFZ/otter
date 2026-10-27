// Danmaku renderers (ADR-012): the engine (index.ts) decides which comments are on the stage and
// where; a renderer turns them into pixels. Canvas 2D is in the main chunk; WebGL (a text atlas,
// one draw call) and its OffscreenCanvas Worker variant are on-demand chunks.

import type { MaskFrame } from './mask.js';
import type { Placed } from './vendor/danmaku/frame.js';

/** A comment on its way through the engine. */
export interface Comment extends Placed {
  readonly index: number;
  readonly text: string;
  /** 0xRRGGBB */
  readonly color: number;
  /** px at font scale 1. */
  readonly size: number;
  readonly own: boolean;
  /** Font px used for the current sprite (size x font scale x stage scale). */
  px: number;
  width: number;
  height: number;
  /** Renderer-owned picture of the text, while on the stage. */
  sprite: unknown;
}

export interface DanmakuRenderer {
  readonly kind: string;
  /**
   * ms from draw() to the picture on screen beyond the usual frame (the Worker: its round trip and
   * its own frame); the engine draws that far ahead while playing, so masks keep to their frame.
   */
  readonly latencyMs?: number;
  /**
   * A renderer that presents on its own (the Worker): its last frame intervals (ms), since the
   * page's rAF pacing does not show a Worker that falls behind.
   */
  readonly ownIntervals?: readonly number[];
  /** The element on the stage (positioned by the engine over the picture). */
  readonly element: HTMLElement;
  /** CSS px and device-pixel ratio of the stage. */
  resize(width: number, height: number, dpr: number): void;
  /** Builds the comment's text picture (its width / height are already measured). */
  prepare(c: Comment): void;
  release(c: Comment): void;
  /** One frame: exactly these comments at their x / y (CSS px), erased under `mask`'s alpha. */
  draw(running: readonly Comment[], mask?: MaskFrame): void;
  destroy(): void;
}

export const FONT_FAMILY = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
export const font = (px: number): string => `bold ${px}px ${FONT_FAMILY}`;
/** Outline around the glyphs (B站's black stroke), px. */
export const STROKE = 1.5;
export const lineHeight = (px: number): number => Math.ceil(px * 1.2 + STROKE * 2);

export const cssColor = (c: number): string => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`;
/** Dark text gets a light outline. */
export const strokeFor = (c: number): string => (((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11 < 48 ? '#fff' : '#000');

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The text of `c` into `ctx` at (x, y) (top-left, CSS px times `scale`). */
export function paintText(ctx: Ctx2D, c: Comment, x: number, y: number, scale: number): void {
  ctx.font = font(c.px * scale);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = STROKE * 2 * scale;
  ctx.strokeStyle = strokeFor(c.color);
  ctx.fillStyle = cssColor(c.color);
  const mid = y + (c.height * scale) / 2;
  ctx.strokeText(c.text, x + STROKE * scale, mid);
  ctx.fillText(c.text, x + STROKE * scale, mid);
  if (c.own) {
    ctx.lineWidth = scale;
    ctx.strokeStyle = '#00a1d6';
    ctx.strokeRect(x + 0.5 * scale, y + 0.5 * scale, (c.width - 1) * scale, (c.height - 1) * scale);
  }
}

/**
 * Canvas 2D: every comment's text drawn once into its own small canvas, the stage redrawn each
 * frame with one drawImage per comment.
 */
export function createCanvasRenderer(doc: Document): DanmakuRenderer {
  const canvas = doc.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%';
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;
  return {
    kind: 'canvas2d',
    element: canvas,
    resize(w, h, ratio) {
      dpr = ratio;
      cssW = w;
      cssH = h;
      canvas.width = Math.max(1, Math.round(w * ratio));
      canvas.height = Math.max(1, Math.round(h * ratio));
    },
    prepare(c) {
      const sprite = doc.createElement('canvas');
      sprite.width = Math.max(1, Math.ceil(c.width * dpr));
      sprite.height = Math.max(1, Math.ceil(c.height * dpr));
      paintText(sprite.getContext('2d') as CanvasRenderingContext2D, c, 0, 0, dpr);
      c.sprite = sprite;
    },
    release(c) {
      c.sprite = undefined;
    },
    draw(running, mask) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const c of running) {
        if (c.x > cssW || c.x + c.width < 0 || c.y > cssH) continue;
        // Whole device pixels: no resampling blur on the text.
        ctx.drawImage(c.sprite as HTMLCanvasElement, Math.round(c.x * dpr), Math.round(c.y * dpr));
      }
      if (mask === undefined) return;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(mask.canvas, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'source-over';
    },
    destroy() {
      canvas.remove();
    },
  };
}
