// Shaka text displayer (ADR-005 §4): Shaka parses and times the cues, the text package renders
// them. Implements shaka.extern.TextDisplayer; nested cues are flattened into one InbandCue each.
// Loaded together with Shaka (not re-exported from the package index).

import type { InbandCue, InbandCues } from '@otter-player/media';

/** The subset of shaka.text.Cue the displayer reads. */
export interface ShakaCue {
  readonly startTime: number;
  readonly endTime: number;
  readonly payload: string;
  readonly nestedCues: readonly ShakaCue[];
  readonly lineBreak?: boolean;
  readonly line: number | null;
  /** 0 LINE_NUMBER, 1 PERCENTAGE */
  readonly lineInterpretation: number;
  readonly lineAlign: string;
  readonly position: number | null;
  readonly positionAlign: string;
  /** Percent, 0 = auto. */
  readonly size: number;
  readonly textAlign: string;
}

export interface ShakaTextDisplayer {
  append(cues: readonly ShakaCue[]): void;
  remove(start: number, end: number): boolean;
  configure(config: unknown): void;
  isTextVisible(): boolean;
  setTextVisibility(on: boolean): void;
  setTextLanguage(language: string): void;
  destroy(): Promise<void>;
}

const textOf = (c: ShakaCue): string =>
  c.lineBreak === true ? '\n' : c.nestedCues.length > 0 ? c.nestedCues.map(textOf).join('') : c.payload;

const LINE_ALIGN = new Set(['start', 'center', 'end']);
const POSITION_ALIGN = new Set(['line-left', 'center', 'line-right', 'auto']);
const ALIGN = new Set(['start', 'center', 'end', 'left', 'right']);

export function toInbandCue(c: ShakaCue): InbandCue {
  const text = textOf(c);
  return {
    id: `${c.startTime}|${c.endTime}|${text}`,
    startTime: c.startTime,
    endTime: c.endTime,
    text,
    ...(c.line === null ? {} : { line: c.line, snapToLines: c.lineInterpretation === 0 }),
    ...(LINE_ALIGN.has(c.lineAlign) ? { lineAlign: c.lineAlign as NonNullable<InbandCue['lineAlign']> } : {}),
    ...(c.position === null ? {} : { position: c.position }),
    ...(POSITION_ALIGN.has(c.positionAlign) ? { positionAlign: c.positionAlign as NonNullable<InbandCue['positionAlign']> } : {}),
    ...(c.size > 0 ? { size: c.size } : {}),
    ...(ALIGN.has(c.textAlign) ? { align: c.textAlign as NonNullable<InbandCue['align']> } : {}),
  };
}

/** `trackId()` names the active text track when cues arrive; null drops them. */
export function createTextDisplayer(trackId: () => string | null, emit: (cues: InbandCues) => void): ShakaTextDisplayer {
  let visible = false;
  let destroyed = false;
  return {
    append(cues) {
      const id = trackId();
      if (destroyed || id === null) return;
      emit({ trackId: id, cues: cues.filter((c) => textOf(c).trim() !== '').map(toInbandCue) });
    },
    remove: () => !destroyed,
    configure: () => undefined,
    isTextVisible: () => visible,
    setTextVisibility(on) {
      visible = on;
    },
    setTextLanguage: () => undefined,
    async destroy() {
      destroyed = true;
    },
  };
}
