// CEA-608 closed captions (ADR-005 §4, ADR-007 §6) for the own TS / FLV pipeline, which hands
// over the raw cc_data from H.264 / HEVC SEI (hls.js and Shaka decode 608 themselves). Parsing is
// hls.js' parser (L3, vendor/hls.js); the screen-to-cue mapping follows the W3C "608 to WebVTT"
// positioning: 15 rows and 32 columns inside the central 80% of the picture. Cues have the
// engine's in-band cue shape (media InbandCue), so the text package renders them like any other.

import Cea608Parser, { type CaptionScreen } from '../vendor/hls.js/cea-608-parser.js';
import OutputFilter, { type CaptionsSink } from '../vendor/hls.js/output-filter.js';

/** Structurally @otter-player/media's InbandCue (pipeline stays free of media types). */
export interface Cea608Cue {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly text: string;
  readonly line: number;
  readonly snapToLines: boolean;
  readonly lineAlign: 'start';
  readonly position: number;
  readonly positionAlign: 'line-left';
  readonly align: 'left';
  readonly size: number;
}

/** Caption channel: CC1 / CC2 on field 1, CC3 / CC4 on field 2. */
export type Cea608Channel = 1 | 2 | 3 | 4;

export interface Cea608Decoder {
  /**
   * One `cc_data()` block of an SEI user_data_registered_itu_t_t35 payload (A/53): the byte
   * with cc_count, then cc_count triplets. `time` is the sample's presentation time, seconds.
   */
  push(time: number, ccData: Uint8Array): void;
  reset(): void;
}

const ROWS = 15;
const COLUMNS = 32;

/** Rows of a caption screen as positioned cues (one per non-empty row). */
export function screenToCues(channel: Cea608Channel, start: number, end: number, screen: CaptionScreen): Cea608Cue[] {
  const cues: Cea608Cue[] = [];
  screen.rows.forEach((row, r) => {
    if (row.isEmpty()) return;
    const raw = row.chars.map((c) => c.uchar).join('');
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text === '') return;
    cues.push({
      id: `cc${channel}:${start}:${r}:${text}`,
      startTime: start,
      endTime: end > start ? end : start + 0.001,
      text,
      snapToLines: false,
      line: 10 + (r * 80) / ROWS,
      lineAlign: 'start',
      position: 10 + (Math.min(indent, COLUMNS - 1) * 80) / COLUMNS,
      positionAlign: 'line-left',
      align: 'left',
      size: 80 - (Math.min(indent, COLUMNS - 1) * 80) / COLUMNS,
    });
  });
  return cues;
}

export function createCea608Decoder(onCues: (channel: Cea608Channel, cues: Cea608Cue[]) => void): Cea608Decoder {
  const sink: CaptionsSink = {
    addCues(trackName, start, end, screen) {
      const channel = Number(trackName.replace('cc', '')) as Cea608Channel;
      const cues = screenToCues(channel, start, end, screen);
      if (cues.length > 0) onCues(channel, cues);
    },
    createCaptionsTrack: () => undefined,
  };
  const field1 = new Cea608Parser(1, new OutputFilter(sink, 'cc1'), new OutputFilter(sink, 'cc2'));
  const field2 = new Cea608Parser(3, new OutputFilter(sink, 'cc3'), new OutputFilter(sink, 'cc4'));
  return {
    push(time, ccData) {
      const count = (ccData[0] ?? 0) & 0x1f;
      const fields: [number[], number[]] = [[], []];
      for (let j = 0, p = 2; j < count && p + 2 < ccData.length; j++, p += 3) {
        const head = ccData[p] ?? 0;
        const b1 = 0x7f & (ccData[p + 1] ?? 0);
        const b2 = 0x7f & (ccData[p + 2] ?? 0);
        // cc_valid with cc_type 0 (field 1) or 1 (field 2); padding pairs are skipped.
        if ((head & 0x04) === 0 || (b1 === 0 && b2 === 0)) continue;
        const type = head & 0x03;
        if (type === 0 || type === 1) fields[type].push(b1, b2);
      }
      if (fields[0].length > 0) field1.addData(time, fields[0]);
      if (fields[1].length > 0) field2.addData(time, fields[1]);
    },
    reset() {
      field1.reset();
      field2.reset();
    },
  };
}
