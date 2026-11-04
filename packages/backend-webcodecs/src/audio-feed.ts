// Feeding the audio decoder (M6 F16, 2026-11-04). AAC decoders hold back the last frame or two
// they were given until more input comes (Safari's: two frames, 42.7 ms at 48 kHz). A live MPEG-TS
// stream delivers audio a PES at a time (live-loop.ts: 16 frames, 0.34 s), so when the next PES
// has not arrived yet the output stops 42.7 ms short of what was received and the sink runs dry
// exactly then (CI desktop-safari: underruns at 5.440 / 5.781 / 6.464 s, each 42.7 ms before a
// PES boundary, in two runs). While the next packet is late, the decoder is flushed once, so what
// it holds comes out; decoding goes on after the flush (every AAC / Opus frame is a key chunk).

import type { DecoderInstance, EncodedChunk } from '@otter-player/media';

/** How long the next packet may take before the decoder is flushed. */
export const DRAIN_MS = 25;

/**
 * The next packet of `it`. When it is not there within `drainMs` and the decoder was fed since
 * its last flush, the decoder is flushed (not awaited: a decode queued behind it runs after it).
 * Returns whether a flush happened, for the caller's bookkeeping.
 */
export async function nextOrDrain(
  it: AsyncIterator<EncodedChunk>,
  decoder: Pick<DecoderInstance, 'flush'>,
  fedSinceFlush: boolean,
  drainMs: number = DRAIN_MS,
): Promise<{ next: IteratorResult<EncodedChunk>; drained: boolean }> {
  const next = it.next();
  if (!fedSinceFlush) return { next: await next, drained: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), drainMs);
  });
  const first = await Promise.race([next, late]);
  clearTimeout(timer);
  if (first !== 'late') return { next: first, drained: false };
  void decoder.flush().catch(() => undefined);
  return { next: await next, drained: true };
}
