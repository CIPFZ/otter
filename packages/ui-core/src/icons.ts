// Icon set (UI-DESIGN §5, ADR-006): Lucide (ISC, L1) for everything it has, drawn on the same
// 24 px grid with 2 px round strokes; the few media glyphs Lucide lacks are drawn here in the same
// style. Icons are IconNode arrays rendered to inline SVG with currentColor: no icon font, no
// images. Each element imports only the icons it shows, so unused ones tree-shake away.

/** Lucide's node format: [tag, attributes][]. */
export type IconNode = readonly (readonly [string, Readonly<Record<string, string | number | undefined>>])[];

const ESC: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const attr = (v: string | number): string => String(v).replace(/[&<>"]/g, (c) => ESC[c] ?? c);

/** Inline SVG markup for an icon (decorative: the control carries the accessible name). */
export function icon(node: IconNode): string {
  const children = node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k, v]) => v !== undefined && k !== 'key')
        .map(([k, v]) => `${k}="${attr(v as string | number)}"`)
        .join(' ');
      return `<${tag} ${a}/>`;
    })
    .join('');
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${children}</svg>`;
}

// ---- Drawn for Otter (same grid and stroke as Lucide) ------------------------------------------

/** Live indicator dot (filled, so it reads at 6 px). */
export const LiveDot: IconNode = [['circle', { cx: 12, cy: 12, r: 5, fill: 'currentColor', stroke: 'none' }]];

/** Spinner: a 3/4 ring, rotated by CSS. */
export const SpinnerRing: IconNode = [['path', { d: 'M21 12a9 9 0 1 1-6.22-8.56' }]];

/** Theater mode: wide frame. */
export const Theater: IconNode = [
  ['rect', { x: 2, y: 6, width: 20, height: 12, rx: 2 }],
  ['path', { d: 'M6 10v4' }],
  ['path', { d: 'M18 10v4' }],
];
