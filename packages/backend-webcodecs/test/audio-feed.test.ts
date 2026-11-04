import type { EncodedChunk } from '@otter-player/media';
import { describe, expect, it } from 'vitest';
import { nextOrDrain } from '../src/audio-feed.ts';

/** An AAC decoder like Safari's: the last two frames come out only with more input or a flush. */
function holdingDecoder() {
  const out: number[] = [];
  let held: number[] = [];
  let flushes = 0;
  return {
    out,
    get flushes() {
      return flushes;
    },
    decode(c: EncodedChunk) {
      held.push(c.timestamp);
      while (held.length > 2) out.push(held.shift() as number);
    },
    flush() {
      flushes++;
      out.push(...held);
      held = [];
      return Promise.resolve();
    },
  };
}

/** A live stream: a PES of 16 frames, then nothing for `gapMs`, then the next PES. */
async function* live(gapMs: number): AsyncGenerator<EncodedChunk> {
  for (let pes = 0; pes < 2; pes++) {
    for (let i = 0; i < 16; i++) yield { type: 'key', timestamp: pes * 16 + i, duration: 1, data: new ArrayBuffer(1) };
    if (pes === 0) await new Promise((r) => setTimeout(r, gapMs));
  }
}

const pump = async (drain: boolean, onGap: (out: number) => void): Promise<ReturnType<typeof holdingDecoder>> => {
  const decoder = holdingDecoder();
  const it = live(200)[Symbol.asyncIterator]();
  let fed = false;
  // What has come out 100 ms into the gap after the first PES.
  setTimeout(() => onGap(decoder.out.length), 100);
  for (;;) {
    const r = drain ? await nextOrDrain(it, decoder, fed) : { next: await it.next(), drained: false };
    if (r.drained) fed = false;
    if (r.next.done === true) break;
    decoder.decode(r.next.value);
    fed = true;
  }
  return decoder;
};

describe('audio feed (M6 F16)', () => {
  it('a late packet flushes the decoder once: the frames it holds come out during the gap', async () => {
    let during = -1;
    const d = await pump(true, (n) => (during = n));
    expect(during).toBe(16);
    expect(d.flushes).toBe(1);
    expect(d.out).toEqual([...Array(30).keys()]);
  });

  it('without it (the old pump), two frames stay inside the decoder until the next PES: the sink runs dry 42.7 ms early', async () => {
    let during = -1;
    await pump(false, (n) => (during = n));
    expect(during).toBe(14);
  });

  it('a packet in time, or nothing fed since the last flush: no flush', async () => {
    const decoder = holdingDecoder();
    const quick = (async function* () {
      yield { type: 'key', timestamp: 0, duration: 1, data: new ArrayBuffer(1) } as EncodedChunk;
    })();
    const r = await nextOrDrain(quick, decoder, true, 50);
    expect(r).toMatchObject({ drained: false, next: { done: false } });
    const slow = (async function* () {
      await new Promise((res) => setTimeout(res, 60));
      yield { type: 'key', timestamp: 1, duration: 1, data: new ArrayBuffer(1) } as EncodedChunk;
    })();
    expect((await nextOrDrain(slow, decoder, false, 10)).drained).toBe(false);
    expect(decoder.flushes).toBe(0);
  });
});
