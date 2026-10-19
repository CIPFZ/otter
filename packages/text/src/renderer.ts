// DOM cue renderer (ADR-005 §4): builds each cue box from the node tree (textContent only),
// measures it at its computed width and positions it with layoutCues inside the display area
// (picture rectangle minus the chrome's safe area). Styling hooks are --otter-cue-* variables.

import type { CueNode, TextCue } from './cue.js';
import { horizontalLayout, layoutCues, type Box } from './layout.js';

export interface CueRenderer {
  readonly element: HTMLElement;
  /** Shows `cues` (already filtered to the active ones) in `area`, container coordinates. */
  render(cues: readonly TextCue[], area: Box, time: number): void;
  destroy(): void;
}

const CSS = `
.otter-cues { position: absolute; pointer-events: none; overflow: hidden;
  font-family: var(--otter-cue-font-family, system-ui, sans-serif);
  font-size: calc(var(--otter-cue-area-height, 360px) * 0.05 * var(--otter-cue-scale, 1));
  line-height: var(--otter-cue-line-height, 1.25); }
.otter-cue { position: absolute; box-sizing: border-box; padding: 0 0.5em;
  white-space: pre-line; overflow-wrap: break-word; transition: top 0.433s; }
.otter-cue-text { color: var(--otter-cue-color, #fff); background: var(--otter-cue-background, rgb(0 0 0 / 0.8));
  text-shadow: var(--otter-cue-text-shadow, none); padding: 0 0.3em;
  box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.otter-cue [data-future] { color: var(--otter-cue-future-color, inherit); }
@media (prefers-reduced-motion: reduce) { .otter-cue { transition: none; } }
`;

const TAG: Readonly<Record<string, string>> = { b: 'b', i: 'i', u: 'u', ruby: 'ruby', rt: 'rt' };

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

  const cueBox = (cue: TextCue, time: number): HTMLElement => {
    let box = boxes.get(cue.id);
    if (box === undefined) {
      box = doc.createElement('div');
      box.className = 'otter-cue';
      box.dataset['cueId'] = cue.id;
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
    render(cues, area, time) {
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
      const fontSize = parseFloat(doc.defaultView?.getComputedStyle(element).fontSize ?? '') || area.height * 0.05;
      const lineHeight = fontSize * 1.25;
      // Pass 2: place.
      const placed = layoutCues(
        cues.map((cue, i) => ({ settings: cue.settings, height: (els[i] as HTMLElement).offsetHeight || lineHeight })),
        area,
        lineHeight,
      );
      placed.forEach((p, i) => {
        const el = els[i] as HTMLElement;
        el.style.left = `${p.left}px`;
        el.style.top = `${p.top}px`;
        el.style.visibility = p.hidden ? 'hidden' : '';
      });
    },
    destroy() {
      element.remove();
      boxes.clear();
    },
  };
}
