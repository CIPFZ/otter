import { describe, expect, it } from 'vitest';
import { cueText } from '@otter-player/text';
import { parseCaptions } from '../src/vtt.js';

const VTT = `WEBVTT

REGION
id:fred
width:40%
lines:3
regionanchor:0%,100%
viewportanchor:10%,90%
scroll:up

1
00:00:00.500 --> 00:00:03.500 line:0 position:20% align:left
<v Fred>Hello <b>bold</b> &lt;img src=x onerror=alert(1)&gt;</v>

00:00:04.000 --> 00:00:07.500 region:fred
Second <c.yellow.big>line</c>
`;

describe('parseCaptions (media-captions)', () => {
  it('maps cues, settings, regions and markup into the cue model', async () => {
    const { cues } = await parseCaptions(VTT, 'vtt', 't');
    expect(cues).toHaveLength(2);
    const [a, b] = cues;
    expect(a).toMatchObject({ id: 't:0', startTime: 0.5, endTime: 3.5, settings: { line: 0, position: 20, align: 'left', region: null } });
    // Entities decode to text, never to markup.
    expect(cueText(a?.nodes ?? [])).toBe('Hello bold <img src=x onerror=alert(1)>');
    expect(a?.nodes[0]).toMatchObject({ type: 'v', voice: 'Fred' });
    expect(b?.settings.region).toMatchObject({ id: 'fred', width: 40, lines: 3, viewportAnchorX: 10, scroll: 'up' });
    // Colour classes become colours; other classes stay classes.
    expect(b?.nodes[1]).toMatchObject({ type: 'c', classes: ['big'], color: 'yellow' });
  });

  it('parses SRT', async () => {
    const { cues } = await parseCaptions('1\n00:00:01,000 --> 00:00:02,500\nSRT line\n', 'srt');
    expect(cues[0]).toMatchObject({ startTime: 1, endTime: 2.5 });
    expect(cueText(cues[0]?.nodes ?? [])).toBe('SRT line');
  });
});
