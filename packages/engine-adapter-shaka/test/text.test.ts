import { describe, expect, it } from 'vitest';
import type { InbandCues } from '@otter-player/media';
// Lazy glue, imported by path (not re-exported from the package index).
import { createTextDisplayer, toInbandCue, type ShakaCue } from '../src/text.js';

const cue = (over: Partial<ShakaCue> = {}): ShakaCue => ({
  startTime: 1,
  endTime: 3,
  payload: '',
  nestedCues: [],
  line: null,
  lineInterpretation: 0,
  lineAlign: 'start',
  position: null,
  positionAlign: 'auto',
  size: 0,
  textAlign: 'center',
  ...over,
});

describe('Shaka text displayer', () => {
  it('flattens nested cues and maps layout', () => {
    const c = cue({
      nestedCues: [cue({ payload: 'Hello' }), cue({ lineBreak: true }), cue({ payload: 'world' })],
      line: 80,
      lineInterpretation: 1,
      position: 30,
      positionAlign: 'line-left',
      size: 40,
      textAlign: 'left',
    });
    expect(toInbandCue(c)).toEqual({
      id: '1|3|Hello\nworld',
      startTime: 1,
      endTime: 3,
      text: 'Hello\nworld',
      line: 80,
      snapToLines: false,
      lineAlign: 'start',
      position: 30,
      positionAlign: 'line-left',
      size: 40,
      align: 'left',
    });
  });

  it('emits for the active track only and drops empty cues', async () => {
    let active: string | null = null;
    const out: InbandCues[] = [];
    const d = createTextDisplayer(() => active, (c) => out.push(c));
    d.append([cue({ payload: 'a' })]);
    expect(out).toEqual([]);
    active = 'text-1';
    d.append([cue({ payload: 'a' }), cue({ payload: '  ' })]);
    expect(out.map((o) => [o.trackId, o.cues.map((c) => c.text)])).toEqual([['text-1', ['a']]]);
    d.setTextVisibility(true);
    expect(d.isTextVisible()).toBe(true);
    expect(d.remove(0, 10)).toBe(true);
    await d.destroy();
    expect(d.remove(0, 10)).toBe(false);
    d.append([cue({ payload: 'late' })]);
    expect(out).toHaveLength(1);
  });
});
