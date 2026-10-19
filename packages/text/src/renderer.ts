// DOM cue renderer (ADR-005 §4): builds each cue box from the node tree (textContent only),
// measures it at its computed width and positions it with layoutCues inside the display area
// (picture rectangle minus the chrome's safe area). Styling hooks are --otter-cue-* variables.

import type { CueNode, TextCue } from './cue.js';
import type { CaptionStyle } from './index.js';
import { horizontalLayout, layoutCues, type Box } from './layout.js';

export interface CueRenderer {
  readonly element: HTMLElement;
  /** Shows `cues` (already filtered to the active ones) in `area`, container coordinates. */
  render(cues: readonly TextCue[], area: Box, time: number, pictureHeight?: number): void;
  /** User caption style (CVAA); unset fields fall back to the skin's --otter-cue-* values. */
  style(style: CaptionStyle): void;
  destroy(): void;
}

// Default look (UI-DESIGN §9): 36 px at a 1080p picture (never below 15 px), weight 500, soft
// shadow, translucent per-line background with rounded corners. CVAA user settings win.
const CSS = `
.otter-cues { position: absolute; pointer-events: none; overflow: hidden;
  font-family: var(--otter-cue-font-family, var(--otter-font, system-ui, sans-serif)); font-weight: 500; letter-spacing: 0.01em;
  font-size: calc(max(15px, var(--otter-cue-picture-height, 360px) * 0.0333) * var(--otter-cue-user-scale, var(--otter-cue-scale, 1)));
  line-height: var(--otter-cue-line-height, 1.35);
  transition: height var(--otter-t-show, 150ms) var(--otter-ease-out, cubic-bezier(0.2, 0, 0, 1)); }
.otter-cue { position: absolute; box-sizing: border-box; padding: 0 0.5em;
  white-space: pre-line; overflow-wrap: break-word; }
/* WebVTT region scroll-up animates; other cues ride on the layer's animated bottom edge. */
.otter-cue[data-region] { transition: bottom 0.433s; }
.otter-cue-text { color: var(--otter-cue-user-color, var(--otter-cue-color, #fff));
  background: var(--otter-cue-user-background, var(--otter-cue-background, rgb(0 0 0 / 0.55)));
  text-shadow: var(--otter-cue-user-shadow, var(--otter-cue-text-shadow, 0 0 4px rgb(0 0 0 / 0.9), 0 1px 2px rgb(0 0 0 / 0.9)));
  font-family: var(--otter-cue-user-font, inherit); padding: 0.11em 0.28em; border-radius: 4px;
  box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.otter-cue [data-future] { color: var(--otter-cue-future-color, inherit); }
@media (prefers-reduced-motion: reduce) { .otter-cues, .otter-cue { transition: none; } }
`;

const TAG: Readonly<Record<string, string>> = { b: 'b', i: 'i', u: 'u', ruby: 'ruby', rt: 'rt' };

/** CEA-708 / CVAA edge styles as text-shadow. */
const EDGES: Readonly<Record<NonNullable<CaptionStyle['edge']>, string>> = {
  none: 'none',
  shadow: '0.06em 0.06em 0.12em rgb(0 0 0 / 0.9)',
  outline: '-0.05em -0.05em 0 #000, 0.05em -0.05em 0 #000, -0.05em 0.05em 0 #000, 0.05em 0.05em 0 #000',
  raised: '-0.04em -0.04em 0 rgb(255 255 255 / 0.6), 0.05em 0.05em 0 #000',
  depressed: '0.04em 0.04em 0 rgb(255 255 255 / 0.6), -0.05em -0.05em 0 #000',
};
const FONTS: Readonly<Record<Exclude<NonNullable<CaptionStyle['font']>, 'default'>, string>> = {
  serif: 'Georgia, "Times New Roman", "Noto Serif SC", serif',
  monospace: 'ui-monospace, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace',
  casual: '"Comic Sans MS", "Comic Neue", "Segoe Print", cursive',
};

/** `#rrggbb` + alpha -> `rgb(r g b / a)`; other colour syntaxes pass through (alpha ignored). */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (m === null) return color;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h as string, 16));
  return `rgb(${r} ${g} ${b} / ${Math.max(0, Math.min(1, alpha))})`;
}

function build(doc: Document, nodes: readonly CueNode[], parent: Node, time: number): void {
  for (const n of nodes) {
    if (n.type === 'text') {
      parent.appendChild(doc.createTextNode(n.text));
      continue;
    }
    const el = doc.createElement(TAG[n.type] ?? 'span');
    if (n.classes.length > 0) el.className = n.classes.join(' ');
    if (n.voice !== undefined) el.dataset['voice'] = n.voice;
    if (n.lang !== undefined) el.lang = n.lang;
    if (n.color !== undefined) el.style.color = n.color;
    if (n.bgColor !== undefined) el.style.backgroundColor = n.bgColor;
    if (n.time !== undefined) {
      el.dataset['time'] = String(n.time);
      if (n.time > time) el.dataset['future'] = '';
    }
    build(doc, n.children, el, time);
    parent.appendChild(el);
  }
}

export function createCueRenderer(parent: HTMLElement): CueRenderer {
  const doc = parent.ownerDocument;
  const element = doc.createElement('div');
  element.className = 'otter-cues';
  element.setAttribute('aria-live', 'off');
  element.dataset['otterCues'] = '';
  const style = doc.createElement('style');
  style.textContent = CSS;
  element.appendChild(style);
  parent.appendChild(element);

  const boxes = new Map<string, HTMLElement>();
  let signature = '';
  let styleKey = '';

  const cueBox = (cue: TextCue, time: number): HTMLElement => {
    let box = boxes.get(cue.id);
    if (box === undefined) {
      box = doc.createElement('div');
      box.className = 'otter-cue';
      box.dataset['cueId'] = cue.id;
      if (cue.settings.region?.scroll === 'up') box.dataset['region'] = cue.settings.region.id;
      if (cue.paint === undefined) {
        const text = doc.createElement('span');
        text.className = 'otter-cue-text';
        build(doc, cue.nodes, text, time);
        box.appendChild(text);
      }
      boxes.set(cue.id, box);
    }
    return box;
  };

  return {
    element,
    render(cues, area, time, pictureHeight = area.height) {
      const key = `${cues.map((c) => c.id).join('|')}@${area.left},${area.top},${area.width},${area.height}`;
      if (key === signature) {
        // Same cues, same area: only karaoke timestamps move.
        for (const el of element.querySelectorAll<HTMLElement>('[data-time]')) {
          if (Number(el.dataset['time']) > time) el.dataset['future'] = '';
          else delete el.dataset['future'];
        }
        return;
      }
      signature = key;
      Object.assign(element.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` });
      element.style.setProperty('--otter-cue-area-height', `${area.height}px`);
      // Size follows the picture, not the area the chrome leaves: showing the bar moves cues, it does not shrink them.
      element.style.setProperty('--otter-cue-picture-height', `${pictureHeight}px`);
      const ids = new Set(cues.map((c) => c.id));
      for (const [id, el] of boxes) {
        if (!ids.has(id)) {
          el.remove();
          boxes.delete(id);
        }
      }
      // Self-positioning cues (IMSC) cover the whole area.
      const painted = cues.filter((c) => c.paint !== undefined);
      for (const cue of painted) {
        const el = cueBox(cue, time);
        Object.assign(el.style, { left: '0', top: '0', width: `${area.width}px`, height: `${area.height}px`, padding: '0' });
        if (el.parentNode !== element) element.appendChild(el);
        cue.paint?.(el, area.width, area.height);
      }
      cues = cues.filter((c) => c.paint === undefined);
      // Pass 1: width and content, so the browser can measure heights.
      const els = cues.map((cue) => {
        const el = cueBox(cue, time);
        const h = horizontalLayout(cue.settings);
        const base = cue.settings.region === null ? area.width : (cue.settings.region.width / 100) * area.width;
        el.style.width = `${(h.widthPct / 100) * base}px`;
        el.style.textAlign = h.textAlign;
        if (el.parentNode !== element) element.appendChild(el);
        return el;
      });
      const fontSize = parseFloat(doc.defaultView?.getComputedStyle(element).fontSize ?? '') || Math.max(15, pictureHeight * 0.0333);
      const lineHeight = fontSize * 1.35;
      // Pass 2: place.
      const placed = layoutCues(
        cues.map((cue, i) => ({ settings: cue.settings, height: (els[i] as HTMLElement).offsetHeight || lineHeight })),
        area,
        lineHeight,
      );
      placed.forEach((p, i) => {
        const el = els[i] as HTMLElement;
        el.style.left = `${p.left}px`;
        // Lower-half cues hang from the bottom edge, so the animated layer height carries them.
        if (p.top + p.height / 2 > area.height / 2) {
          el.style.top = '';
          el.style.bottom = `${area.height - p.top - p.height}px`;
        } else {
          el.style.bottom = '';
          el.style.top = `${p.top}px`;
        }
        el.style.visibility = p.hidden ? 'hidden' : '';
      });
    },
    style(style) {
      const key = JSON.stringify(style);
      if (key === styleKey) return;
      styleKey = key;
      // A size change re-measures every box.
      signature = '';
      const set = (name: string, value: string | undefined): void => {
        if (value === undefined) element.style.removeProperty(name);
        else element.style.setProperty(name, value);
      };
      set('--otter-cue-user-scale', style.scale === undefined ? undefined : String(style.scale));
      set('--otter-cue-user-color', style.color === undefined && style.opacity === undefined ? undefined : withAlpha(style.color ?? '#ffffff', style.opacity ?? 1));
      set(
        '--otter-cue-user-background',
        style.background === undefined && style.backgroundOpacity === undefined ? undefined : withAlpha(style.background ?? '#000000', style.backgroundOpacity ?? 0.8),
      );
      set('--otter-cue-user-shadow', style.edge === undefined ? undefined : EDGES[style.edge]);
      set('--otter-cue-user-font', style.font === undefined || style.font === 'default' ? undefined : FONTS[style.font]);
    },
    destroy() {
      element.remove();
      boxes.clear();
    },
  };
}
