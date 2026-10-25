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
 * so are details a backend annotates onto its own step (decoder build, MMS handling), and the
 * codec probing / choice steps (codecs-prefs.spec.ts).
 */
const chain = (r: Run): string[] =>
  r.steps
    .filter((s) => s.outcome !== 'rejected' && !s.candidate.startsWith('format:') && !s.candidate.startsWith('codec ') && s.candidate !== 'platform')
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

/** Frame number painted into the frames/*.mp4 clips, read from the player's WebCodecs canvas. */
async function frameOnPlayer(page: Page): Promise<number> {
  // The bars' gradients would darken the blocks: hidden for the screenshot only.
  const style = await page.addStyleTag({ content: '[data-otter-top], [data-otter-controls], [data-otter-center] { visibility: hidden !important; }' });
  const png = (await page.locator('[data-otter-frames]').screenshot({ animations: 'disabled' })).toString('base64');
  await style.evaluate((el) => (el as Element).remove());
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(img, 0, 0);
    let bits = 0;
    for (let i = 0; i < 10; i++) {
      const d = ctx.getImageData(Math.floor(((i * 48 + 24) / 640) * img.width), Math.floor((24 / 360) * img.height), 1, 1).data;
      if ((d[0] as number) + (d[1] as number) + (d[2] as number) > 384) bits |= 1 << i;
    }
    return bits;
  }, png);
}

for (const [mode, details] of [
  ['hwfail', 'decodeError'],
  ['hwstall', 'decoderStalled'],
] as const) {
  test(`runtime fallback (${mode}): the hardware decoder breaks mid-stream, WASM continues in the same backend`, async ({ page, browserName }) => {
    test.setTimeout(90_000);
    // Known flaky on CI WebKit (hwfail): the backend sometimes stays on webcodecs for 30 s, also on
    // the retry (cc100ae); not reproducible without WebKit here. Skipped there until it is
    // located (RESEARCH §1, M4 report); hwstall still runs on WebKit.
    test.fixme(browserName === 'webkit' && mode === 'hwfail', 'flaky on CI WebKit: runtime fallback not reached within 30 s (RESEARCH §1)');
    // 150 packets: past the first keyframe interval (90), so the restart is from a later keyframe.
    await page.goto(`/player.html?${mode}=150&idle=0`);
    await page.evaluate(async () => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load({ src: await o.fetchBlob('/frames/h264-video-only.mp4') }, { autoplay: true, startTime: 1 });
    });
    const backend = () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().backend);
    await expect.poll(backend, { timeout: 30_000 }).toBe('wasm');
    const r = await page.evaluate(async () => {
      const o = (await window.otter) as OtterFixture;
      return {
        steps: o.explain()?.steps ?? [],
        explainBackend: o.explain()?.backend,
        // Plain fields: Error objects lose their own properties on the way out of the page.
        errors: o.events
          .filter((e) => e.type === 'error')
          .map((e) => {
            const err = (e.payload as { error: { details: string; fatal: boolean } }).error;
            return { details: err.details, fatal: err.fatal };
          }),
        routes: o.events.filter((e) => e.type === 'route').length,
      };
    });
    // The route says what happened, in order, and its backend is now the WASM step.
    expect(r.explainBackend).toBe('wasm');
    const failed = r.steps.findIndex((s) => s.candidate === 'webcodecs' && s.outcome === 'failed' && s.reason.startsWith(details) && s.reason.endsWith('(runtime)'));
    const selected = r.steps.findIndex((s) => s.candidate === 'wasm' && s.outcome === 'selected' && s.reason.startsWith('runtime fallback inside backend-webcodecs'));
    expect(failed).toBeGreaterThan(-1);
    expect(selected).toBeGreaterThan(failed);
    // QoE: one non-fatal decoderFallback, nothing fatal, no reload by the session.
    expect(r.errors.filter((e) => e.details === 'decoderFallback')).toHaveLength(1);
    expect(r.errors.filter((e) => e.fatal)).toEqual([]);
    // Playback goes on, and stays frame accurate on the new decoder.
    const t0 = await page.evaluate(async () => ((await window.otter) as OtterFixture).state().currentTime);
    await expect.poll(() => page.evaluate(async () => ((await window.otter) as OtterFixture).state().currentTime), { timeout: 15_000 }).toBeGreaterThan(t0 + 1);
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('seek', { time: (200 + 0.7) / 30 }));
    await expect.poll(() => page.evaluate(async () => ((await window.otter) as OtterFixture).state().seeking), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => frameOnPlayer(page), { timeout: 10_000 }).toBe(200);
    ciNotice(`runtime fallback (${mode}): ${r.steps.filter((s) => s.reason.endsWith('(runtime)') || s.reason.startsWith('runtime fallback')).map((s) => `${s.candidate} ${s.outcome}`).join(' > ')}`);
  });
}
