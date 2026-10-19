// Own pipeline output plays in real browsers (ADR-007 §2): FLV and MPEG-TS transmuxed to fMP4,
// appended to MSE without any engine, buffered as one range and decoded while playing.

import { expect, test } from './fixtures';

for (const [name, url, kind, chunk] of [
  ['FLV (mpegts.js demuxer, L2)', '/flv/clip.flv', 'flv', 16_384],
  ['FLV in small live-style chunks', '/flv/clip.flv', 'flv', 1_000],
  ['MPEG-TS (hls.js demuxer, L2)', '/ts/clip.ts', 'ts', 188 * 64],
] as const) {
  test(`own transmuxer output plays: ${name}`, async ({ page }) => {
    await page.goto('/transmux.html');
    const r = await page.evaluate(async ({ url, kind, chunk }) => (window.transmuxPlay as NonNullable<Window['transmuxPlay']>)(url, kind, chunk), { url, kind, chunk });
    expect(r.errors).toEqual([]);
    expect(r.supported.every(Boolean), r.mimeTypes.join(' | ')).toBe(true);
    // One continuous buffered range of the whole clip (no gaps at fragment boundaries).
    expect(r.buffered).toHaveLength(1);
    expect((r.buffered[0]?.[1] ?? 0) - (r.buffered[0]?.[0] ?? 0)).toBeGreaterThan(kind === 'flv' ? 9.5 : 7.5);
    expect(r.played).toBeGreaterThan(2);
    expect(r.decoded).toBeGreaterThan(40);
  });
}
