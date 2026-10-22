// cn-live over WebRTC (SPEC §19 国内直播, ADR-008 §8): format-whep against the local WHEP endpoint
// (e2e/whep.ts, a werift peer sending a looped VP8 clip). The MediaStream plays on the native
// backend; ICE that cannot connect goes down the fallback chain to the source's fallback (the
// local HTTP-FLV live stream).

import { appendFileSync, mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const state = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const s = o.state();
    return {
      status: s.status,
      t: s.currentTime,
      paused: s.paused,
      backend: s.backend,
      format: s.format,
      latency: s.latency,
      width: (document.querySelector('video') as HTMLVideoElement).videoWidth,
      errors: o.events.filter((e) => e.type === 'error').map((e) => (e.payload as { error: { details: string } }).error.details),
      steps: s.route?.steps.map((r) => `${r.candidate} ${r.outcome} ${r.reason}`) ?? [],
    };
  });

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

/**
 * Whether this browser gathers any ICE candidate at all. Headless Firefox in some containers does
 * not (gathering stays `new`, "ICE failed" before any answer); nothing to test there.
 */
const gathers = (page: Page): Promise<boolean> =>
  page.evaluate(async () => {
    const pc = new RTCPeerConnection();
    let any = false;
    // Candidate events, not the SDP: real Firefox (Windows) gathers but its localDescription read
    // here did not list them.
    pc.onicecandidate = (e) => (any ||= e.candidate !== null && e.candidate.candidate !== '');
    pc.addTransceiver('video', { direction: 'recvonly' });
    await pc.setLocalDescription(await pc.createOffer());
    for (let i = 0; i < 30 && !any; i++) await new Promise((r) => setTimeout(r, 100));
    pc.close();
    return any;
  });

/**
 * Firefox under automation does not start ICE gathering on a document loaded straight from the
 * local server (gathering stays `new`; data: URLs and documents fulfilled through Playwright's
 * routing gather at once, RESEARCH §1): its documents go through routing here. Its host
 * candidates are mDNS names the werift fixture cannot resolve, so the Firefox projects turn
 * obfuscation off (playwright.config.ts).
 */
async function routeDocuments(page: Page, browserName: string): Promise<void> {
  if (browserName === 'firefox') await page.route('**/*', async (r) => (r.request().resourceType() === 'document' ? r.fulfill({ response: await r.fetch() }) : r.fallback()));
}

async function load(page: Page, source: object, query = ''): Promise<void> {
  await page.goto(`/player.html?idle=0${query}`);
  await page.evaluate(async (src) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load(src as Parameters<OtterFixture['load']>[0], { autoplay: true });
  }, source);
}

test('cn-live WHEP: the WebRTC stream plays on the native backend', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  await routeDocuments(page, browserName);
  await page.goto('/player.html?idle=0');
  if (!(await gathers(page))) {
    ciNotice('WHEP: this browser gathers no ICE candidates here; WebRTC playback not testable');
    return;
  }
  await load(page, { src: '/whep/live', type: 'application/whep', live: true });
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(1);
  const s = await state(page);
  expect(s).toMatchObject({ status: 'ready', paused: false, backend: 'native', format: 'whep', width: 320, errors: [] });
  // New pictures keep arriving (25 fps source).
  const frames = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const v = document.querySelector('video') as HTMLVideoElement;
        let n = 0;
        const count = (): void => {
          n++;
          v.requestVideoFrameCallback(count);
        };
        v.requestVideoFrameCallback(count);
        setTimeout(() => resolve(n), 1000);
      }),
  );
  expect(frames).toBeGreaterThan(10);
  // Sub-second: the receiver's jitter buffer, from WebRTC stats.
  await expect.poll(async () => (await state(page)).latency, { timeout: 5000 }).not.toBeNull();
  expect((await state(page)).latency as number).toBeLessThan(1);
  // The audio track (Opus, 440 Hz tone) arrives and carries sound: RMS of the received stream
  // through an AnalyserNode (the player is muted; the stream itself is not).
  const audio = await page.evaluate(async () => {
    const stream = (document.querySelector('video') as HTMLVideoElement).srcObject as MediaStream;
    const tracks = stream.getAudioTracks().length;
    const ctx = new AudioContext();
    const running = await Promise.race([ctx.resume().then(() => ctx.state === 'running'), new Promise<boolean>((r) => setTimeout(() => r(false), 1000))]);
    if (!running || tracks === 0) return { tracks, running, rms: 0 };
    const analyser = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let rms = 0;
    for (let i = 0; i < 20 && rms < 0.01; i++) {
      await new Promise((r) => setTimeout(r, 100));
      analyser.getFloatTimeDomainData(data);
      rms = Math.sqrt(data.reduce((a, x) => a + x * x, 0) / data.length);
    }
    void ctx.close();
    return { tracks, running, rms };
  });
  expect(audio.tracks).toBe(1);
  if (audio.running) expect(audio.rms).toBeGreaterThan(0.01);
  ciNotice(`WHEP: video ${frames} frames/s, audio track ${audio.running ? `RMS ${audio.rms.toFixed(3)}` : '(no running AudioContext to measure it)'}`);
});

test('cn-live WHEP: ICE that cannot connect falls back to the HTTP-FLV source', async ({ page, browserName }) => {
  test.setTimeout(60_000);
  await routeDocuments(page, browserName);
  await load(page, { src: '/whep/ice-fail', type: 'application/whep', live: true, fallback: { src: '/live/stream.flv', live: true } }, '&ice=2000');
  await expect.poll(async () => (await state(page)).format, { timeout: 20_000 }).toBe('flv');
  await expect.poll(async () => (await state(page)).t, { timeout: 20_000 }).toBeGreaterThan(0.5);
  const s = await state(page);
  expect(s).toMatchObject({ status: 'ready', paused: false });
  // No retry of the same offer: one iceFailed, straight to the fallback source.
  expect(s.errors).toEqual(['iceFailed']);
  expect(s.steps.some((r) => r === 'source fallback selected format flv')).toBe(true);
});
