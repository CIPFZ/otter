// Three-level fallback (SPEC §5.2 / §6.3, ADR-008 §5, M4 acceptance): with hardware decoding
// switched off (?hw=off) the WebCodecs step fails and the WASM decoder takes over; with the WASM
// decoder unavailable as well (?wasm=fail, its files missing) the route ends on MSE. Each step
// leaves an `error` QoE event naming the steps still left, a `route` QoE event with the decision,
// and the same steps in router.explain().

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

interface Run {
  readonly status: string;
  readonly backend: string | null;
  readonly steps: readonly { readonly candidate: string; readonly outcome: string; readonly reason: string }[];
  readonly errors: { details: string; fallback: string[] }[];
  readonly routes: (string | null)[];
}

async function play(page: Page, query: string, src: string): Promise<Run> {
  await page.goto(`/player.html?${query}`);
  await page.evaluate(
    async ([s, codecs]) => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load(codecs === '' ? { src: s } : { src: s, codecs }, { autoplay: true });
    },
    [src, src.includes('hevc') ? 'hvc1.1.6.L93.90' : ''] as const,
  );
  await expect.poll(() => page.evaluate(async () => ((await window.otter) as OtterFixture).state().status), { timeout: 30_000 }).toMatch(/ready|error/);
  // Playback advances on the step that took it.
  await expect.poll(() => page.evaluate(async () => ((await window.otter) as OtterFixture).state().currentTime), { timeout: 20_000 }).toBeGreaterThan(1.5);
  return page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    return {
      status: o.state().status,
      backend: o.state().backend,
      steps: o.explain()?.steps ?? [],
      errors: o.events.filter((e) => e.type === 'error').map((e) => {
        const p = e.payload as { error: { details: string }; fallback: string[] };
        return { details: p.error.details, fallback: p.fallback };
      }),
      routes: o.events.filter((e) => e.type === 'route').map((e) => (e.payload as { backend: string | null }).backend),
    };
  });
}

/**
 * The selected / failed steps of the chain, in order. Format and platform lines are left out, and
 * so are details a backend annotates onto its own step (decoder build, MMS handling).
 */
const chain = (r: Run): string[] =>
  r.steps
    .filter((s) => s.outcome !== 'rejected' && !s.candidate.startsWith('format:') && s.candidate !== 'platform')
    .map((s) => `${s.candidate} ${s.outcome}`)
    .filter((s, i, all) => s !== all[i - 1]);

test('hardware decoding off: WebCodecs -> WASM -> MSE, each step observable', async ({ page }) => {
  test.setTimeout(90_000);
  // H.264 HLS with the host preferring WebCodecs (the whole chain), hardware off, WASM missing.
  const r = await play(page, 'prefer=webcodecs&hw=off&wasm=fail', '/hls-fmp4/master.m3u8');
  expect(r.status).toBe('ready');
  expect(r.backend).toBe('mse');
  expect(chain(r)).toEqual(['webcodecs selected', 'webcodecs failed', 'wasm selected', 'wasm failed', 'mse selected']);
  expect(r.steps).toContainEqual({ candidate: 'platform', outcome: 'selected', reason: 'WebCodecs preferred by policy: full chain' });
  expect(r.steps).toContainEqual({ candidate: 'webcodecs', outcome: 'failed', reason: 'codecUnsupported' });
  expect(r.steps).toContainEqual({ candidate: 'wasm', outcome: 'failed', reason: 'workerDecoderFailed' });
  // QoE: one error per failed step, each naming what is left, in order; a route event per decision.
  // (native follows where the browser plays HLS itself.)
  expect(r.errors.slice(0, 2).map((e) => ({ details: e.details, next: e.fallback.filter((f) => f !== 'native') }))).toEqual([
    { details: 'codecUnsupported', next: ['wasm', 'mse'] },
    { details: 'workerDecoderFailed', next: ['mse'] },
  ]);
  expect(r.routes.filter((b) => b !== null)).toEqual(expect.arrayContaining(['wasm', 'mse']));
  expect(r.routes.at(-1)).toBe('mse');
  ciNotice(`fallback: ${chain(r).join(' > ')}; QoE errors ${r.errors.map((e) => e.details).join(', ')}`);
});

test('hardware decoding off: HEVC HLS goes to the WASM decoder', async ({ page }) => {
  test.setTimeout(90_000);
  const r = await play(page, 'hw=off', '/frames/hls-hevc/master.m3u8');
  // Browsers with HEVC in MSE (Firefox here) never need WebCodecs: the default order is MSE first.
  if (r.backend === 'mse') {
    ciNotice('hevc with hw=off: MSE plays HEVC here, WebCodecs not tried');
    return;
  }
  expect(r.backend).toBe('wasm');
  expect(chain(r)).toEqual(['webcodecs selected', 'webcodecs failed', 'wasm selected']);
  expect(r.errors[0]?.details).toBe('codecUnsupported');
  expect(r.errors[0]?.fallback.slice(0, 2)).toEqual(['wasm', 'mse']);
  // How the WASM step runs is part of the explanation.
  expect(r.steps.find((s) => s.candidate === 'wasm' && / on wasm-hevc /.test(s.reason))?.reason).toMatch(/jv4-decoder .*crossOriginIsolated (true|false)/);
});
