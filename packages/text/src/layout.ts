// WebVTT cue layout (W3C WebVTT §7.2 "processing cue settings" and §7.3 region rules), written
// for Otter's own renderer (ADR-005 §4). Pure: the renderer measures each cue box at its computed
// width and hands the heights back here, so the geometry is testable without a browser.
// Horizontal writing only; `vertical` cues are laid out horizontally (M2 limitation).

export type CueAlign = 'start' | 'center' | 'end' | 'left' | 'right';
export type PositionAlign = 'line-left' | 'center' | 'line-right' | 'auto';

export interface RegionSettings {
  readonly id: string;
  /** Percent of the video width. */
  readonly width: number;
  readonly lines: number;
  /** Percent of the region box. */
  readonly regionAnchorX: number;
  readonly regionAnchorY: number;
  /** Percent of the video viewport. */
  readonly viewportAnchorX: number;
  readonly viewportAnchorY: number;
  readonly scroll: 'up' | '';
}

export interface CueSettings {
  readonly line: number | 'auto';
  readonly snapToLines: boolean;
  readonly lineAlign: 'start' | 'center' | 'end';
  /** Percent of the video width (or region width), or `auto`. */
  readonly position: number | 'auto';
  readonly positionAlign: PositionAlign;
  /** Percent of the video width (or region width). */
  readonly size: number;
  readonly align: CueAlign;
  readonly region: RegionSettings | null;
}


/** Display area in px: the picture rectangle minus the part the chrome covers. */
export interface Area {
  readonly width: number;
  readonly height: number;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface HorizontalLayout {
  /** Percent of the containing block (video or region). */
  readonly leftPct: number;
  readonly widthPct: number;
  readonly textAlign: 'left' | 'center' | 'right' | 'start' | 'end';
}

/** §7.2 steps for position, position alignment and size (left-to-right text). */
export function horizontalLayout(s: CueSettings): HorizontalLayout {
  const position =
    s.position !== 'auto' ? s.position : s.align === 'left' || s.align === 'start' ? 0 : s.align === 'right' || s.align === 'end' ? 100 : 50;
  const positionAlign: Exclude<PositionAlign, 'auto'> =
    s.positionAlign !== 'auto'
      ? s.positionAlign
      : s.align === 'left' || s.align === 'start'
        ? 'line-left'
        : s.align === 'right' || s.align === 'end'
          ? 'line-right'
          : 'center';
  const max = positionAlign === 'line-left' ? 100 - position : positionAlign === 'line-right' ? position : position <= 50 ? position * 2 : (100 - position) * 2;
  const widthPct = Math.max(0, Math.min(s.size, max));
  const leftPct = positionAlign === 'line-left' ? position : positionAlign === 'line-right' ? position - widthPct : position - widthPct / 2;
  return { leftPct, widthPct, textAlign: s.align };
}

export interface LayoutItem {
  readonly settings: CueSettings;
  /** Measured height of the cue box at its computed width, px. */
  readonly height: number;
}

export interface PlacedCue extends Box {
  /** Region cue scrolled out of its region, or a cue that could not be placed in the area. */
  readonly hidden: boolean;
}

// Half a pixel of slack: measured boxes are rounded (offsetHeight) while the line step is not,
// and a 0.25 px "overlap" must not push a cue up a whole extra line.
const EPS = 0.5;
const overlaps = (a: Box, b: Box): boolean =>
  a.left < b.left + b.width - EPS &&
  b.left < a.left + a.width - EPS &&
  a.top < b.top + b.height - EPS &&
  b.top < a.top + a.height - EPS;

const inside = (b: Box, area: Area): boolean => b.top >= -0.5 && b.top + b.height <= area.height + 0.5;

/**
 * Places the active cues in document order (earlier cues first, as the spec's "rendering rules").
 * `lineHeight` is the px height of one caption line, the unit of snap-to-lines positioning.
 */
export function layoutCues(items: readonly LayoutItem[], area: Area, lineHeight: number): PlacedCue[] {
  const placed: Box[] = [];
  const out: PlacedCue[] = [];
  const regionStacks = new Map<string, { region: RegionSettings; members: number[] }>();

  items.forEach((item, index) => {
    const s = item.settings;
    if (s.region !== null && s.line === 'auto' && s.snapToLines) {
      // Region cues stack inside their region; placed after the loop.
      const stack = regionStacks.get(s.region.id) ?? { region: s.region, members: [] };
      stack.members.push(index);
      regionStacks.set(s.region.id, stack);
      out[index] = { left: 0, top: 0, width: 0, height: item.height, hidden: true };
      return;
    }
    const h = horizontalLayout(s);
    const left = (h.leftPct / 100) * area.width;
    const width = (h.widthPct / 100) * area.width;
    const box = (top: number): Box => ({ left, top, width, height: item.height });
    const free = (b: Box): boolean => inside(b, area) && !placed.some((p) => overlaps(b, p));

    let result: Box | undefined;
    if (s.snapToLines) {
      // Line number: non-negative counts from the top, negative from the bottom; auto is -1.
      const line = s.line === 'auto' ? -1 : Math.trunc(s.line);
      const step = Math.max(1, lineHeight);
      const start = line >= 0 ? line * step : area.height + (line + 1) * step - item.height;
      const direction = line >= 0 ? 1 : -1;
      // Move away from the edge one line at a time; out of the area, retry once the other way.
      for (const dir of [direction, -direction]) {
        for (let top = start; ; top += dir * step) {
          const b = box(top);
          if (!inside(b, area)) break;
          if (free(b)) {
            result = b;
            break;
          }
        }
        if (result !== undefined) break;
      }
    } else {
      const pct = s.line === 'auto' ? 100 : s.line;
      const anchor = s.lineAlign === 'start' ? 0 : s.lineAlign === 'center' ? item.height / 2 : item.height;
      const start = Math.min(Math.max(0, (pct / 100) * area.height - anchor), Math.max(0, area.height - item.height));
      if (free(box(start))) {
        result = box(start);
      } else {
        // Nearest free spot just above or below an overlapping box.
        const candidates = placed
          .filter((p) => p.left < left + width && left < p.left + p.width)
          .flatMap((p) => [p.top - item.height, p.top + p.height])
          .sort((a, b) => Math.abs(a - start) - Math.abs(b - start));
        result = candidates.map(box).find(free);
      }
    }
    if (result === undefined) {
      // No room: the spec keeps the cue at its first position, overlapping.
      const fallback = s.snapToLines
        ? box(s.line === 'auto' || s.line < 0 ? Math.max(0, area.height - item.height) : 0)
        : box(Math.max(0, area.height - item.height));
      out[index] = { ...fallback, hidden: false };
      placed.push(fallback);
      return;
    }
    out[index] = { ...result, hidden: false };
    placed.push(result);
  });

  for (const { region, members } of regionStacks.values()) {
    const rw = (region.width / 100) * area.width;
    const rh = region.lines * Math.max(1, lineHeight);
    const rLeft = (region.viewportAnchorX / 100) * area.width - (region.regionAnchorX / 100) * rw;
    const rTop = (region.viewportAnchorY / 100) * area.height - (region.regionAnchorY / 100) * rh;
    // Newest cue at the bottom; older cues scroll up and out of the region box.
    let bottom = rTop + rh;
    for (let i = members.length - 1; i >= 0; i--) {
      const index = members[i] as number;
      const item = items[index] as LayoutItem;
      const h = horizontalLayout(item.settings);
      const top = bottom - item.height;
      out[index] = {
        left: rLeft + (h.leftPct / 100) * rw,
        top,
        width: (h.widthPct / 100) * rw,
        height: item.height,
        hidden: top < rTop - 0.5,
      };
      bottom = top;
    }
  }
  return out;
}

/**
 * Display area for cues: the picture rectangle (letterbox excluded) shortened by the part of the
 * chrome's safe area that actually covers the picture. Coordinates relative to the container.
 */
export function cueArea(content: Box, container: Area, safeBottom: number): Box {
  const covered = Math.max(0, safeBottom - (container.height - (content.top + content.height)));
  return { left: content.left, top: content.top, width: content.width, height: Math.max(0, content.height - covered) };
}
