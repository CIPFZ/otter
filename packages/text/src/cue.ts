// Unified cue model (ADR-005 §4). Every source (sidecar VTT / SRT, engine in-band cues, CEA-608)
// becomes TextCue; the renderer only knows this shape. Cue text is a node tree, never an HTML
// string: subtitle files are untrusted input.

import type { CueSettings } from './layout.js';

/** WebVTT defaults (§3.1); here rather than in layout.ts, which loads with the first cue drawn. */
export const DEFAULT_CUE_SETTINGS: CueSettings = {
  line: 'auto',
  snapToLines: true,
  lineAlign: 'start',
  position: 'auto',
  positionAlign: 'auto',
  size: 100,
  align: 'center',
  region: null,
};

export type CueNodeType = 'b' | 'i' | 'u' | 'ruby' | 'rt' | 'c' | 'v' | 'lang' | 'timestamp';

export type CueNode =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: CueNodeType;
      readonly classes: readonly string[];
      /** `<v Speaker>` */
      readonly voice?: string;
      /** `<lang xx>` */
      readonly lang?: string;
      /** `<00:00:01.000>` karaoke timestamp, seconds. */
      readonly time?: number;
      readonly color?: string;
      readonly bgColor?: string;
      readonly children: readonly CueNode[];
    };

export interface TextCue {
  readonly id: string;
  /** Seconds. */
  readonly startTime: number;
  readonly endTime: number;
  readonly nodes: readonly CueNode[];
  readonly settings: CueSettings;
  /**
   * Cues that position themselves (IMSC1 ISDs via imscJS): drawn into a box covering the whole
   * display area instead of the WebVTT layout. `nodes` still carries the text for a11y and tests.
   */
  readonly paint?: (into: HTMLElement, width: number, height: number) => void;
}

/** Plain-text cue (CEA-608 rows, engine cues without markup). */
export function plainCue(id: string, startTime: number, endTime: number, text: string, settings: Partial<CueSettings> = {}): TextCue {
  const lines = text.split('\n');
  const nodes: CueNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) nodes.push({ type: 'text', text: '\n' });
    nodes.push({ type: 'text', text: line });
  });
  return { id, startTime, endTime, nodes, settings: { ...DEFAULT_CUE_SETTINGS, ...settings } };
}

/** Active cues at `time`, in start order (the order the layout stacks them). */
export function activeCues(cues: readonly TextCue[], time: number): TextCue[] {
  return cues.filter((c) => c.startTime <= time && time < c.endTime).sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
}

export const cueText = (nodes: readonly CueNode[]): string =>
  nodes.map((n) => (n.type === 'text' ? n.text : cueText(n.children))).join('');
