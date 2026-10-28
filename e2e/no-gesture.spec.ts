// Playback before any user gesture on the WebCodecs backend (M6 test round F1, ADR-008 §2): muted,
// no AudioContext, the wall clock, nothing reported; the first gesture brings the context.
//
// Playwright's page.evaluate runs WITH a user gesture, and so does tracing (its DOM snapshots,
// from the first document on; RESEARCH §1). So this file runs without a trace, and nothing is
// evaluated before the assertions: the page loads and plays from an init script and reports over
// a binding (AGENT §4).

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { WebCodecsFixture } from './site/webcodecs.ts';

test.use({ trace: 'off' });

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

/** The stock Firefox driven over WebDriver BiDi (channel moz-firefox). */
const bidi = (): boolean => (test.info().project.use as { channel?: string }).channel?.startsWith('moz-firefox') === true;

type Report = { activation: boolean | null; contexts: number; currentTime: number; paused: boolean; muted: boolean; errors: string[] };

/** Loads and plays h264.mp4 from an init script; resolves with what the page saw after 2 s of playback. */
async function playWithoutGesture(page: Page): Promise<Report> {
  let report: Report | undefined;
  await page.exposeBinding('otterReport', (_source, r: Report) => {
    report = r;
  });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    const w = window as unknown as { contexts: AudioContext[]; otterReport(r: unknown): void; wc?: Promise<WebCodecsFixture> };
    const Native = window.AudioContext;
    w.contexts = [];
    window.AudioContext = class extends Native {
      constructor(options?: AudioContextOptions) {
        super(options);
        w.contexts.push(this);
      }
    };
    const begin = setInterval(() => {
      if (w.wc === undefined) return;
      clearInterval(begin);
      void w.wc.then(async (f) => {
        await f.load('h264.mp4');
        f.dispatch('play', undefined);
        setTimeout(() => {
          const s = f.state();
          const activation = (navigator as { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? null;
          const errors = f.events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string } }).error.details);
          w.otterReport({ activation, contexts: w.contexts.length, currentTime: s.currentTime, paused: s.paused, muted: s.muted, errors });
        }, 2000);
      });
    }, 20);
  });
  await page.goto('/webcodecs.html');
  await expect.poll(() => report, { timeout: 30_000 }).toBeDefined();
  const r = report as Report;
  test.skip(r.activation === null, 'no navigator.userActivation here: the backend cannot tell a gesture and takes one as given');
  // Playwright over WebDriver BiDi (the stock Firefox) gives every page a user activation before
  // any of its scripts runs (RESEARCH §1): there is no gesture-free page to test.
  if (r.activation === true && bidi()) {
    ciNotice('no gesture: the page already had a user activation (Playwright over WebDriver BiDi), not testable');
    test.skip(true, 'WebDriver BiDi pages start with a user activation');
  }
  return r;
}

test('h264.mp4 without a user gesture: muted, no AudioContext, the wall clock, no audioClockUnavailable', async ({ page }) => {
  test.setTimeout(60_000);
  const r = await playWithoutGesture(page);
  expect(r.activation).toBe(false);
  expect(r.contexts).toBe(0);
  expect(r.muted).toBe(true);
  expect(r.paused).toBe(false);
  // No context: the time that moved came from performance.now().
  expect(r.currentTime).toBeGreaterThan(1.5);
  expect(r.errors).not.toContain('audioClockUnavailable');
  ciNotice(`no gesture: ${r.contexts} AudioContexts, muted ${r.muted}, ${r.currentTime.toFixed(2)} s played on the wall clock, no audioClockUnavailable`);
});

test('h264.mp4 started without a gesture: the first gesture makes the AudioContext and it becomes the clock', async ({ page }) => {
  test.setTimeout(60_000);
  const r = await playWithoutGesture(page);
  expect(r.contexts).toBe(0);
  await page.mouse.click(5, 5);
  const contexts = () => page.evaluate(() => (window as unknown as { contexts: AudioContext[] }).contexts.map((c) => c.state));
  await expect.poll(async () => (await contexts()).length, { timeout: 5000 }).toBe(1);
  const running = await expect
    .poll(contexts, { timeout: 5000 })
    .toEqual(['running'])
    .then(
      () => true,
      () => false,
    );
  if (!running) {
    // Headless Firefox has no output device: its contexts never run (RESEARCH §1).
    ciNotice(`first gesture: the AudioContext was made but does not run here (${(await contexts()).join(', ')}), not testable`);
    test.skip(true, 'the AudioContext does not run here (no audio output device)');
  }
  await page.waitForTimeout(1000);
  const after = await page.evaluate(async () => {
    const f = await (window.wc as Promise<WebCodecsFixture>);
    return { paused: f.state().paused, t: f.state().currentTime, errors: f.events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string } }).error.details) };
  });
  expect(after.paused).toBe(false);
  expect(after.t).toBeGreaterThan(r.currentTime);
  expect(after.errors).not.toContain('audioClockUnavailable');
  ciNotice(`first gesture: 1 AudioContext running, the clock on it, ${after.t.toFixed(2)} s played, no audioClockUnavailable`);
});
