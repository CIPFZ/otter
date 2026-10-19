// @vitest-environment happy-dom
// imscJS touches `window` when its HTML renderer module loads, so even parsing needs a DOM.
import { describe, expect, it } from 'vitest';
import { cueText, DEFAULT_CUE_SETTINGS } from '@otter-player/text';
import { parseTtml } from '../src/ttml.js';

const TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xml:lang="en">
  <head><layout><region xml:id="bottom" tts:origin="10% 80%" tts:extent="80% 15%"/></layout></head>
  <body region="bottom"><div>
    <p begin="00:00:01.000" end="00:00:03.000">First TTML</p>
    <p begin="00:00:04.000" end="00:00:06.000">Second<br/>row</p>
  </div></body>
</tt>`;

describe('parseTtml (imscJS)', () => {
  it('splits the document at its time events and keeps the text', async () => {
    const cues = await parseTtml(TTML, DEFAULT_CUE_SETTINGS, 'x');
    expect(cues.map((c) => [c.startTime, c.endTime, cueText(c.nodes)])).toEqual([
      [1, 3, 'First TTML'],
      [4, 6, 'Second\nrow'],
    ]);
    const into = document.createElement('div');
    document.body.appendChild(into);
    cues[0]?.paint?.(into, 640, 360);
    expect(into.textContent).toContain('First TTML');
  });
});
