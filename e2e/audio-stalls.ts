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

/**
 * Gaps between consecutive event times (ms) longer than `limitMs`, as stall spans, and those that
 * overlap [from, to]: the same shape as the AudioContext's record, for a transport's own record
 * (the WHEP fixture's RTCP arrivals, owner 2026-11-03).
 */
export function gapsAsStalls(times: readonly number[], limitMs: number, from = Number.NEGATIVE_INFINITY, to = Number.POSITIVE_INFINITY): StallSpan[] {
  const out: StallSpan[] = [];
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1] as number;
    const b = times[i] as number;
    if (b - a > limitMs && b >= from && a <= to) out.push({ from: a, to: b });
  }
  // Still open at `to`: nothing since the last one.
  const last = times.at(-1);
  if (last !== undefined && to < Number.POSITIVE_INFINITY && to - last > limitMs && last <= to) out.push({ from: last, to: null });
  return out;
}

// ---- F14 (owner 2026-10-29 / 11-02 / 11-03): emulated Android's decoder falls behind real time --

/** One 0.2 s summary of the WebCodecs backend's audio sink (backend-webcodecs audio.ts 'stat'). */
export interface SinkStat {
  readonly media: number;
  readonly ahead: number;
  readonly under: number;
  readonly fill?: number;
  readonly gap: number;
  readonly late: number;
  readonly disc: number;
  readonly dq: number;
  /** performance.now() when the page got it. */
  readonly wall: number;
}

/** Records the sink's summaries in `window.sinkStats` (wraps AudioWorkletNode; call before goto). */
export async function recordSinkStats(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { sinkStats?: unknown[] };
    if (w.sinkStats !== undefined) return;
    w.sinkStats = [];
    const Native = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        this.port.addEventListener('message', (e: MessageEvent<{ t: string }>) => {
          if (e.data.t === 'stat') (w.sinkStats as unknown[]).push({ ...e.data, wall: performance.now() });
        });
        this.port.start();
      }
    };
  });
}

export const sinkStats = (page: Page): Promise<SinkStat[]> => page.evaluate(() => ((window as unknown as { sinkStats?: SinkStat[] }).sinkStats ?? []).slice());

/** A sink summary that ran dry with the decoder's queue at its cap: F14's signature. */
export const isF14Window = (x: Pick<SinkStat, 'under' | 'dq'>): boolean => x.under > 0 && x.dq >= 17;

/** Underrun messages ("audio ran dry at T s for N ms ..."): media time and length. */
const parseUnderrun = (m: string): { at: number; ms: number } => ({ at: Number(/dry at ([\d.]+) s/.exec(m)?.[1] ?? Number.NaN), ms: Number(/for (\d+) ms/.exec(m)?.[1] ?? 0) });

export interface F14Verdict {
  /** Underruns let through, each with the summary it matched (same / adjacent 0.2 s window). */
  readonly letThrough: readonly { readonly message: string; readonly summary: SinkStat; readonly adjacent: boolean; readonly offset: number }[];
  /** Underruns outside the signature: still failures. */
  readonly kept: readonly string[];
  /** Total silence let through, ms (more than 1 s in one run is still a failure). */
  readonly letMs: number;
}

/** Most silence F14 may account for in one run, ms (owner 2026-11-03). */
export const F14_MAX_MS = 1000;

/**
 * F14's rule, the same for every audio case on emulated-android: an underrun whose media time is
 * within 0.4 s of a summary with F14's signature is let through; every other underrun is kept.
 * Elsewhere every underrun is kept.
 */
export function f14Verdict(project: string, underruns: readonly string[], stats: readonly SinkStat[]): F14Verdict {
  if (project !== 'emulated-android') return { letThrough: [], kept: [...underruns], letMs: 0 };
  const letThrough: F14Verdict['letThrough'][number][] = [];
  const kept: string[] = [];
  for (const message of underruns) {
    const { at } = parseUnderrun(message);
    const hit = stats.filter((x) => Math.abs(x.media - at) <= 0.4 && isF14Window(x)).sort((a, b) => Math.abs(a.media - at) - Math.abs(b.media - at))[0];
    if (hit === undefined) kept.push(message);
    else letThrough.push({ message, summary: hit, adjacent: Math.abs(hit.media - at) > 0.2, offset: Math.abs(hit.media - at) });
  }
  return { letThrough, kept, letMs: letThrough.reduce((n, u) => n + parseUnderrun(u.message).ms, 0) };
}

/** The notice line of a verdict (per case: `F14 [<case>]: ...`), for the per-case tally in RESEARCH. */
export const f14Notice = (name: string, v: F14Verdict): string =>
  `F14 [${name}]: ${v.letThrough.length} underruns let through, ${Math.round(v.letMs)} ms in all${v.letThrough.length > 0 ? `: ${v.letThrough.map((u) => `${u.message} -> summary [media ${u.summary.media.toFixed(3)} ahead ${u.summary.ahead.toFixed(2)} under ${u.summary.under} dq ${u.summary.dq}] ${u.adjacent ? 'adjacent' : 'same'} window (${u.offset.toFixed(3)} s)`).join(' | ')}` : ''}`;
