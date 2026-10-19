import { describe, expect, it } from 'vitest';
import { cueText, type TextCue } from '@otter-player/text';
import { createCea608Decoder, type Cea608Channel } from '../src/cea608.js';

/** cc_data(): process flag + cc_count, em_data, then field-1 (0xfc) triplets for each byte pair. */
const block = (...pairs: [number, number][]): Uint8Array =>
  Uint8Array.from([0x40 | pairs.length, 0xff, ...pairs.flatMap(([a, b]) => [0xfc, a, b])]);

describe('CEA-608 decoder (hls.js parser, L3)', () => {
  it('pop-on caption: shown at End Of Caption, ends at Erase Displayed Memory', () => {
    const out: [Cea608Channel, TextCue[]][] = [];
    const d = createCea608Decoder((ch, cues) => out.push([ch, cues]));
    // Resume Caption Loading, PAC row 15 indent 0, "HI!", End Of Caption (control codes doubled, as broadcast).
    d.push(1.0, block([0x14, 0x20], [0x14, 0x20], [0x14, 0x70], [0x14, 0x70]));
    d.push(1.1, block([0x48, 0x49], [0x21, 0x00]));
    d.push(1.2, block([0x14, 0x2f], [0x14, 0x2f]));
    // Erase Displayed Memory closes the cue.
    d.push(3.0, block([0x14, 0x2c], [0x14, 0x2c]));
    expect(out).toHaveLength(1);
    const [channel, cues] = out[0] as [Cea608Channel, TextCue[]];
    expect(channel).toBe(1);
    expect(cues).toHaveLength(1);
    const cue = cues[0] as TextCue;
    expect(cueText(cue.nodes)).toBe('HI!');
    expect(cue.startTime).toBeCloseTo(1.2, 5);
    expect(cue.endTime).toBeCloseTo(3.0, 5);
    // Row 15 of 15: bottom of the 608 safe area, left aligned.
    expect(cue.settings).toMatchObject({ snapToLines: false, align: 'left', positionAlign: 'line-left', position: 10 });
    expect(cue.settings.line).toBeCloseTo(10 + (14 * 80) / 15, 5);
  });

  it('ignores invalid and padding triplets', () => {
    const out: unknown[] = [];
    const d = createCea608Decoder((_ch, cues) => out.push(cues));
    d.push(0, Uint8Array.from([0x42, 0xff, 0xf8, 0x14, 0x20, 0xfc, 0x80, 0x80]));
    expect(out).toEqual([]);
  });
});
