// The shared AudioContext's own record of stalls, kept apart from the player (M6 F9), and the
// "environment stall" acceptance built on it (owner 2026-10-29, ADR-008 §7). Shared by the
// multi-view and surveillance benches.
//
// recordAudioStalls() wraps AudioContext before the page loads: every 20 ms it reads the context's
// time, and every stretch of 300 ms or more in which the context said running but its time did not
// move becomes a stall (`ctxStalls`: `at+length` ms after the context's creation; `ctxSpans`:
// performance.now() from / to, an open one to = Infinity).

import type { Page } from '@playwright/test';
import { expect } from './fixtures';

export interface StallSpan {
  readonly from: number;
  /** null: still open. */
  readonly to: number | null;
}

export async function recordAudioStalls(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.AudioContext;
    const w = window as unknown as { ctxStalls: string[]; ctxSpans: { from: number; to: number }[] };
    w.ctxStalls = [];
    w.ctxSpans = [];
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        const t0 = performance.now();
        let last = -1;
        let since = 0;
        let open: { from: number; to: number } | undefined;
        const id = setInterval(() => {
          const now = performance.now();
          if (this.state !== 'running' || this.currentTime !== last) {
            if (last >= 0 && now - since >= 300) w.ctxStalls.push(`${Math.round(since - t0)}+${Math.round(now - since)}${this.state === 'running' ? '' : ` (${this.state})`}`);
            if (open !== undefined) open.to = now;
            open = undefined;
            last = this.currentTime;
            since = now;
          } else if (open === undefined && now - since >= 300) {
            open = { from: since, to: Infinity };
            w.ctxSpans.push(open);
          }
          if (now - t0 > 60_000) clearInterval(id);
        }, 20);
      }
    };
  });
}

/** The stalls as `at+length` (ms after the context's creation), for notices. */
export const audioStalls = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { ctxStalls?: string[] }).ctxStalls ?? []);

export const stallSpans = (page: Page): Promise<StallSpan[]> =>
  page.evaluate(() => ((window as unknown as { ctxSpans?: { from: number; to: number }[] }).ctxSpans ?? []).map((x) => ({ from: x.from, to: Number.isFinite(x.to) ? x.to : null })));

/** The span `at` (performance.now()) falls in, from `before` ms before it to `after` ms after it. */
export const spanAt = (spans: readonly StallSpan[], at: number, before = 50, after = 500): StallSpan | undefined => spans.find((x) => at >= x.from - before && at <= (x.to ?? Infinity) + after);

export interface TileErrors {
  readonly tile: string;
  readonly errors: readonly string[];
  readonly messages: readonly string[];
  /** performance.now() of each error. */
  readonly errorAt: readonly number[];
}

/**
 * A frozen-clock report (`audioClockUnavailable`, "time frozen") is the environment's only when the
 * independent record shows the context's time standing >= 0.5 s around it (the watchdog fires 0.5 s
 * into a stall) and the tile's route says the clock is back on the context within 5 s of the
 * stall's end. `recovery(i)`: tile i's recovery route step and when it appeared, or null.
 * Returns each tile's other errors and a line per accepted report.
 */
export async function acceptEnvironmentStalls(
  page: Page,
  tiles: readonly TileErrors[],
  recovery: (i: number) => Promise<{ reason: string; at: number } | null>,
): Promise<{ kept: string[][]; accepted: string[] }> {
  const spans = await stallSpans(page);
  const kept: string[][] = [];
  const accepted: string[] = [];
  for (const [i, r] of tiles.entries()) {
    const own: string[] = [];
    for (const [k, e] of r.errors.entries()) {
      const at = r.errorAt[k] as number;
      const span = spans.find((x) => (x.to ?? Infinity) - x.from >= 500 && at >= x.from + 450 && at <= (x.to ?? Infinity) + 100);
      if (e !== 'audioClockUnavailable' || !/time frozen/.test(r.messages[k] ?? '') || span === undefined) {
        own.push(e);
        continue;
      }
      // The stall ends (if it has not), then within 5 s the route says the clock is back.
      await expect.poll(async () => (await stallSpans(page)).every((x) => x.to !== null), { timeout: 15_000 }).toBe(true);
      const end = (await stallSpans(page)).find((x) => x.from === span.from)?.to ?? 0;
      const back = async () => {
        const st = await recovery(i);
        return st !== null && /^audio clock: back on the AudioContext after a [\d.]+ s stall( \(via a state change\))?$/.test(st.reason) ? st : null;
      };
      const wait = Math.max(500, end + 5000 - (await page.evaluate(() => performance.now())));
      await expect.poll(async () => (await back())?.reason ?? null, { timeout: wait, message: `${r.tile}: back on the AudioContext within 5 s of the stall's end` }).not.toBeNull();
      // When it appeared: within 5 s of the stall's end (not just by now).
      const st = (await back()) as { reason: string; at: number };
      expect(st.at, `${r.tile}: the recovery came ${Math.round(st.at - end)} ms after the stall's end`).toBeLessThanOrEqual(end + 5000);
      accepted.push(`${r.tile}: environment stall ${Math.round(span.from)}..${Math.round(end)} ms (${((end - span.from) / 1000).toFixed(2)} s), reported at ${Math.round(at)} ms; ${st.reason} (${Math.round(st.at)} ms)`);
    }
    kept.push(own);
  }
  return { kept, accepted };
}
