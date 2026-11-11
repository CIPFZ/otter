// Companion mode, stop 0 (docs/design/COMPANION.md): what Document Picture-in-Picture does in this
// browser. Records only; every result goes to test-results/probes/<project>/<name>.json and the
// console. RESEARCH §1 has the numbers from each run.
//
//  1. geometry   - the window size each requested size gets; whether a 240 x 44 strip opens.
//  2. reopen     - whether a second window on the same site keeps the last position and size.
//  3. resize     - whether resizeTo / resizeBy / moveTo work after opening, with which activation.
//  4. close      - the events of closing from the opener, from the window, and as the user would.
//  5. decode     - decoded frames and CPU with the picture shown / hidden in the window (MSE,
//                  native <video>, WebCodecs canvas).
//  6. auto-pip   - MediaSession `enterpictureinpicture`: accepted, and called on leaving the tab?

import { mkdirSync, writeFileSync } from 'node:fs';
import type { BrowserContext, BrowserContextOptions, CDPSession, Page } from '@playwright/test';
import { test } from '../fixtures';
import type { OtterFixture } from '../site/player.ts';

type Size = { width: number; height: number };
interface Geometry {
  inner: [number, number];
  outer: [number, number];
  at: [number, number];
}

const record = (name: string, data: unknown): void => {
  const dir = `test-results/probes/${test.info().project.name}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}.json`, JSON.stringify(data, null, 2));
  console.log(`[${test.info().project.name}] ${name}: ${JSON.stringify(data)}`);
};

/**
 * Fresh context without viewport emulation, so a PiP window keeps the size the browser gave it.
 * The test runner merges the project's device options into newContext; explicit undefined clears
 * them (deviceScaleFactor is refused with a null viewport), which the option types do not allow.
 */
const NO_EMULATION = { viewport: null, deviceScaleFactor: undefined, isMobile: undefined, hasTouch: undefined } as unknown as BrowserContextOptions;
const freshContext = async (page: Page): Promise<BrowserContext> => page.context().browser()!.newContext(NO_EMULATION);

const hasDocPip = (page: Page): Promise<boolean> => page.evaluate(() => 'documentPictureInPicture' in window && window.top === window);

/** Opens a window from the opener (evaluate carries a user gesture) and returns its Page too. */
async function openPip(opener: Page, options: Record<string, unknown> | undefined): Promise<{ pip: Page | undefined; geometry: Geometry | { error: string } }> {
  const pagePromise = opener
    .context()
    .waitForEvent('page', { timeout: 3000 })
    .catch(() => undefined);
  const geometry = await opener.evaluate(async (o) => {
    try {
      const dpip = (window as unknown as { documentPictureInPicture: { requestWindow(o?: object): Promise<Window> } }).documentPictureInPicture;
      const w = await (o === undefined ? dpip.requestWindow() : dpip.requestWindow(o));
      await new Promise((r) => setTimeout(r, 400));
      return { inner: [w.innerWidth, w.innerHeight], outer: [w.outerWidth, w.outerHeight], at: [w.screenX, w.screenY] } as Geometry;
    } catch (e) {
      return { error: `${(e as Error).name}: ${(e as Error).message}` };
    }
  }, options);
  return { pip: await pagePromise, geometry };
}

const pipGeometry = (opener: Page): Promise<Geometry | null> =>
  opener.evaluate(() => {
    const w = (window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window;
    return w === null ? null : ({ inner: [w.innerWidth, w.innerHeight], outer: [w.outerWidth, w.outerHeight], at: [w.screenX, w.screenY] } as Geometry);
  });

const closePip = async (opener: Page): Promise<void> => {
  await opener.evaluate(() => (window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window?.close());
  await opener.waitForFunction(() => (window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window === null);
};

const screenInfo = (page: Page) => page.evaluate(() => ({ avail: [screen.availWidth, screen.availHeight], dpr: devicePixelRatio, ua: navigator.userAgent }));

test.beforeEach(async ({ page }) => {
  await page.goto('/player.html?idle=0');
  if (!(await hasDocPip(page))) {
    record(`${test.info().title}-skipped`, { reason: 'no documentPictureInPicture', ...(await screenInfo(page)) });
    test.skip(true, 'no Document PiP here');
  }
});

test('geometry', async ({ page }) => {
  test.setTimeout(120_000);
  const sizes: (Size | undefined)[] = [undefined, { width: 100, height: 30 }, { width: 240, height: 44 }, { width: 240, height: 135 }, { width: 320, height: 180 }, { width: 440, height: 248 }, { width: 4000, height: 3000 }];
  const rows: unknown[] = [];
  for (const size of sizes) {
    // A fresh profile per size: nothing remembered from the previous window.
    const ctx = await freshContext(page);
    const opener = await ctx.newPage();
    await opener.goto('/player.html?idle=0');
    const { geometry } = await openPip(opener, size);
    rows.push({ requested: size ?? 'none', ...geometry });
    if (!('error' in geometry)) await closePip(opener);
    await ctx.close();
  }
  record('geometry', { screen: await screenInfo(page), rows });
});

test('reopen', async ({ page }) => {
  test.setTimeout(120_000);
  const ctx = await freshContext(page);
  const opener = await ctx.newPage();
  await opener.goto('/player.html?idle=0');
  const steps: unknown[] = [];
  const step = async (label: string, options: Record<string, unknown> | undefined): Promise<void> => {
    const { geometry } = await openPip(opener, options);
    steps.push({ label, requested: options ?? 'none', ...geometry });
  };
  await step('first 320x180', { width: 320, height: 180 });
  // Programmatic resize / move (a user's drag cannot be scripted here).
  const moved = await opener.evaluate(() => {
    const w = (window as unknown as { documentPictureInPicture: { window: Window } }).documentPictureInPicture.window;
    const errors: string[] = [];
    try {
      w.resizeTo(500, 300);
    } catch (e) {
      errors.push(`resizeTo ${(e as Error).name}`);
    }
    try {
      w.moveTo(40, 40);
    } catch (e) {
      errors.push(`moveTo ${(e as Error).name}`);
    }
    return errors;
  });
  await opener.waitForTimeout(400);
  steps.push({ label: 'after resizeTo(500,300) + moveTo(40,40) from the opener', errors: moved, geometry: await pipGeometry(opener) });
  await closePip(opener);
  await step('reopen, no size', undefined);
  await closePip(opener);
  await step('reopen 320x180', { width: 320, height: 180 });
  await closePip(opener);
  await step('reopen 440x248', { width: 440, height: 248 });
  await closePip(opener);
  await step('reopen 320x180 preferInitialWindowPlacement', { width: 320, height: 180, preferInitialWindowPlacement: true });
  await closePip(opener);
  await opener.reload();
  await step('after reload, 320x180', { width: 320, height: 180 });
  await closePip(opener);
  await ctx.close();
  record('reopen', steps);
});

test('resize', async ({ page }) => {
  test.setTimeout(120_000);
  const ctx = await freshContext(page);
  const opener = await ctx.newPage();
  await opener.goto('/player.html?idle=0');
  const { pip, geometry } = await openPip(opener, { width: 320, height: 180 });
  const rows: unknown[] = [{ label: 'opened 320x180', ...geometry, pipPage: pip !== undefined }];
  // From the opener, inside a gesture (evaluate carries one).
  const call = async (target: Page, label: string, code: string, delayMs: number): Promise<void> => {
    const result = await target.evaluate(
      async ([src, delay]) => {
        const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
        if ((delay as number) > 0) await wait(delay as number);
        const activation = (navigator as unknown as { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation;
        const before = { isActive: activation?.isActive, hasBeenActive: activation?.hasBeenActive };
        let error: string | undefined;
        try {
          new Function(src as string)();
        } catch (e) {
          error = `${(e as Error).name}: ${(e as Error).message}`;
        }
        return { before, error, after: { isActive: activation?.isActive } };
      },
      [code, delayMs] as const,
    );
    await opener.waitForTimeout(400);
    rows.push({ label, ...result, geometry: await pipGeometry(opener) });
  };
  const fromOpener = 'documentPictureInPicture.window.';
  await call(opener, 'opener, with activation: resizeTo(440,248)', `${fromOpener}resizeTo(440,248)`, 0);
  // Transient activation lasts 5 s in Chromium (RESEARCH §1): wait it out inside the page.
  await call(opener, 'opener, activation expired (6 s): resizeTo(240,135)', `${fromOpener}resizeTo(240,135)`, 6000);
  await call(opener, 'opener, with activation: resizeBy(-200,-204)', `${fromOpener}resizeBy(-200,-204)`, 0);
  if (pip !== undefined) {
    await call(pip, 'window itself, with activation: resizeTo(240,44)', 'window.resizeTo(240,44)', 0);
    await call(pip, 'window itself, activation expired (6 s): resizeTo(320,180)', 'window.resizeTo(320,180)', 6000);
    await call(pip, 'window itself, with activation: moveTo(0,0)', 'window.moveTo(0,0)', 0);
  }
  await closePip(opener);
  await ctx.close();
  record('resize', rows);
});

test('close', async ({ page }) => {
  test.setTimeout(120_000);
  const cases = ['opener calls close()', 'window calls close()', 'Playwright closes the window page'] as const;
  const rows: unknown[] = [];
  for (const kind of cases) {
    const ctx = await freshContext(page);
    const opener = await ctx.newPage();
    await opener.goto('/player.html?idle=0');
    const { pip } = await openPip(opener, { width: 320, height: 180 });
    await opener.evaluate(() => {
      const log: { at: number; where: string; type: string; detail?: unknown }[] = [];
      (window as unknown as { probeLog: typeof log }).probeLog = log;
      const t0 = performance.now();
      const add = (where: string, type: string, detail?: unknown): void => void log.push({ at: Math.round(performance.now() - t0), where, type, ...(detail === undefined ? {} : { detail }) });
      const w = (window as unknown as { documentPictureInPicture: { window: Window } }).documentPictureInPicture.window;
      for (const type of ['pagehide', 'unload', 'beforeunload', 'visibilitychange', 'blur', 'focus'])
        w.addEventListener(type, (e) => add('pip', type, type === 'pagehide' ? { persisted: (e as PageTransitionEvent).persisted, visibility: w.document.visibilityState } : undefined));
      for (const type of ['focus', 'blur']) window.addEventListener(type, () => add('opener', type, { hasFocus: document.hasFocus(), visibility: document.visibilityState }));
      document.addEventListener('visibilitychange', () => add('opener', 'visibilitychange', document.visibilityState));
      add('opener', 'armed', { hasFocus: document.hasFocus() });
    });
    if (kind === 'opener calls close()') await opener.evaluate(() => (window as unknown as { documentPictureInPicture: { window: Window } }).documentPictureInPicture.window.close());
    else if (kind === 'window calls close()') await pip?.evaluate(() => window.close());
    else await pip?.close();
    await opener.waitForTimeout(800);
    const log = await opener.evaluate(() => ({ log: (window as unknown as { probeLog: unknown[] }).probeLog, hasFocus: document.hasFocus(), visibility: document.visibilityState }));
    rows.push({ kind, pipPage: pip !== undefined, ...log });
    await ctx.close();
  }
  record('close', rows);
});

// ---- 5. Decoding with the picture hidden ----------------------------------------------------

// All 1280 x 720 H.264 + AAC. A progressive MP4 URL routes to native even with prefer=mse, so the
// MSE path plays the HLS demo (hls format, MSE backend; its ABR settles on 720p).
const PATHS = [
  { name: 'mse', query: '&prefer=mse', clip: '/demo/master.m3u8', blob: false },
  { name: 'native', query: '&prefer=native', clip: '/frames/h264-720p-av.mp4', blob: false },
  { name: 'webcodecs', query: '&prefer=webcodecs', clip: '/frames/h264-720p-av.mp4', blob: true },
] as const;
const WINDOW_MS = 3000;

/** CPU seconds per Chromium process type since the browser started (CDP SystemInfo). */
async function cpu(cdp: CDPSession): Promise<Record<string, number>> {
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number; cpuTime: number }[] };
  const out: Record<string, number> = {};
  for (const p of processInfo) out[p.type] = (out[p.type] ?? 0) + p.cpuTime;
  return out;
}

/** Frame counters of the player, wherever it is now (page or PiP window). */
const counters = (page: Page) =>
  page.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    const pipDoc = (window as unknown as { documentPictureInPicture?: { window: Window | null } }).documentPictureInPicture?.window?.document;
    const doc = pipDoc ?? document;
    const v = doc.querySelector('#player video, [data-otter-player] video') as (HTMLVideoElement & { webkitDecodedFrameCount?: number; webkitDroppedFrameCount?: number }) | null;
    const q = v?.getVideoPlaybackQuality();
    const s = o.state();
    return {
      t: s.currentTime,
      paused: s.paused,
      backend: s.backend,
      mode: s.presentation?.mode,
      total: q?.totalVideoFrames ?? null,
      dropped: q?.droppedVideoFrames ?? null,
      decoded: v?.webkitDecodedFrameCount ?? null,
      // WebCodecs: frames released on this thread (drawn and closed), counted by the init script.
      closed: (window as unknown as { probeClosed?: number }).probeClosed ?? null,
      rvfc: (window as unknown as { probeRvfc?: number }).probeRvfc ?? null,
    };
  });

for (const path of PATHS) {
  test(`decode ${path.name}`, async ({ page, browserName }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      const w = window as unknown as { probeClosed: number };
      w.probeClosed = 0;
      if (typeof VideoFrame === 'function') {
        const close = VideoFrame.prototype.close;
        VideoFrame.prototype.close = function (this: VideoFrame) {
          w.probeClosed++;
          close.call(this);
        };
      }
    });
    await page.goto(`/player.html?idle=0&pip=document${path.query}`);
    await page.evaluate(
      async ([clip, blob]) => {
        const o = (await window.otter) as OtterFixture;
        o.dispatch('set-muted', { muted: true });
        o.load({ src: blob ? await o.fetchBlob(clip as string) : (clip as string) }, { autoplay: true });
      },
      [path.clip, path.blob] as const,
    );
    await page.waitForFunction(async () => ((await window.otter) as OtterFixture).state().currentTime > 0.5, undefined, { timeout: 30_000 });
    // Presented-frame count of the <video> (stops when nothing is composited).
    await page.evaluate(() => {
      const w = window as unknown as { probeRvfc: number };
      w.probeRvfc = 0;
      const v = document.querySelector('#player video') as HTMLVideoElement;
      const tick = (): void => {
        w.probeRvfc++;
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    });
    const cdp = browserName === 'chromium' ? await page.context().browser()!.newBrowserCDPSession() : undefined;
    const windows: unknown[] = [];
    const measure = async (label: string): Promise<void> => {
      await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('seek', { time: 1 }));
      await page.waitForTimeout(500);
      const c0 = cdp === undefined ? undefined : await cpu(cdp);
      const a = await counters(page);
      const w0 = Date.now();
      await page.waitForTimeout(WINDOW_MS);
      const b = await counters(page);
      const c1 = cdp === undefined ? undefined : await cpu(cdp);
      const sec = (Date.now() - w0) / 1000;
      const per = (x: number | null, y: number | null): number | null => (x === null || y === null ? null : Math.round(((y - x) / sec) * 10) / 10);
      const cpuPct: Record<string, number> = {};
      if (c0 !== undefined && c1 !== undefined) for (const k of Object.keys(c1)) cpuPct[k] = Math.round((((c1[k] ?? 0) - (c0[k] ?? 0)) / sec) * 1000) / 10;
      windows.push({
        label,
        seconds: Math.round(sec * 100) / 100,
        mediaAdvance: Math.round((b.t - a.t) * 100) / 100,
        paused: b.paused,
        backend: b.backend,
        mode: b.mode,
        perSecond: { total: per(a.total, b.total), dropped: per(a.dropped, b.dropped), decoded: per(a.decoded, b.decoded), closed: per(a.closed, b.closed), rvfc: per(a.rvfc, b.rvfc) },
        cpuPercentOfOneCore: cpuPct,
      });
    };
    const hide = (how: string): Promise<void> =>
      page.evaluate((h) => {
        const pipDoc = (window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window?.document;
        const doc = pipDoc ?? document;
        for (const el of doc.querySelectorAll<HTMLElement>('[data-otter-player] > video, [data-otter-frames]')) {
          el.style.display = h === 'display' ? 'none' : '';
          el.style.visibility = h === 'visibility' ? 'hidden' : '';
        }
      }, how);

    await measure('inline, picture shown');
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-pip', {}));
    await page.waitForFunction(async () => ((await window.otter) as OtterFixture).state().presentation?.mode === 'docpip', undefined, { timeout: 8000 });
    await measure('docpip, picture shown');
    await hide('display');
    await measure('docpip, picture display:none');
    await hide('visibility');
    await measure('docpip, picture visibility:hidden');
    await hide('none');
    await measure('docpip, picture shown again');
    record(`decode-${path.name}`, { clip: path.clip, windows });
    await cdp?.detach();
  });
}

test('auto-pip', async ({ page }) => {
  test.setTimeout(60_000);
  const ctx = await freshContext(page);
  const opener = await ctx.newPage();
  await opener.goto('/player.html?idle=0&pip=document');
  const registered = await opener.evaluate(() => {
    const w = window as unknown as { probeAuto: string[] };
    w.probeAuto = [];
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture' as MediaSessionAction, () => {
        w.probeAuto.push(`called, activation ${String((navigator as unknown as { userActivation?: { isActive: boolean } }).userActivation?.isActive)}`);
        void (window as unknown as { documentPictureInPicture: { requestWindow(o?: object): Promise<Window> } }).documentPictureInPicture
          .requestWindow({ width: 320, height: 180 })
          .then(() => w.probeAuto.push('window opened'))
          .catch((e: Error) => w.probeAuto.push(`requestWindow ${e.name}: ${e.message}`));
      });
      return 'accepted';
    } catch (e) {
      return `${(e as Error).name}: ${(e as Error).message}`;
    }
  });
  const permission = await opener.evaluate(async () => {
    try {
      return (await navigator.permissions.query({ name: 'automatic-picture-in-picture' as PermissionName })).state;
    } catch (e) {
      return `${(e as Error).name}: ${(e as Error).message}`;
    }
  });
  // Audible playback (auto PiP is for playing media with sound), started inside a gesture.
  await opener.evaluate(async () => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: false });
    o.load({ src: '/frames/h264-720p-av.mp4' }, { autoplay: true });
  });
  await opener.waitForFunction(async () => ((await window.otter) as OtterFixture).state().currentTime > 0.5, undefined, { timeout: 20_000 });
  const before = await opener.evaluate(() => ({ visibility: document.visibilityState, paused: (document.querySelector('video') as HTMLVideoElement).paused, muted: (document.querySelector('video') as HTMLVideoElement).muted }));
  // Another tab in the same window takes the front (window.open inside a gesture).
  const tabPromise = ctx.waitForEvent('page');
  await opener.evaluate(() => void window.open('/index.html', '_blank'));
  const tab = await tabPromise;
  await tab.bringToFront();
  await opener.waitForTimeout(2500);
  const after = await opener.evaluate(() => ({
    visibility: document.visibilityState,
    calls: (window as unknown as { probeAuto: string[] }).probeAuto,
    pipWindow: (window as unknown as { documentPictureInPicture: { window: Window | null } }).documentPictureInPicture.window !== null,
  }));
  record('auto-pip', { registered, permission, before, after });
  await ctx.close();
});
