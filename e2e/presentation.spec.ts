// Presentation modes end to end (SPEC §15, ADR-007 §5): every mode on every project. Capabilities
// come from feature detection, so each test asserts what the reported capability promises: a
// `native` / `emulated` mode is entered with a real click and confirmed by the browser, a `false`
// one is refused with `denied { reason: 'unsupported' }`. Transitions are request -> confirm or
// roll back; refusals carry a reason.
//
// emulated-iphone: Playwright's iPhone is desktop WebKit with an iPhone viewport and UA, so it
// still has element fullscreen. An init script gives it the iPhone Safari API shape (no element
// fullscreen, `webkitEnterFullscreen` on <video>, no Document PiP) so the pseudo-fullscreen path
// runs; real iPhones are covered by the ADR-004 device run. OTTER_IPHONE_SHAPE=1 applies the same
// shape to any project (local runs without WebKit).

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

type Mode = 'inline' | 'theater' | 'fullscreen' | 'pip' | 'docpip' | 'mini' | 'background';
interface Presentation {
  mode: Mode;
  pending: Mode | null;
  capabilities: Record<Mode, 'native' | 'emulated' | false>;
  videoOnly: boolean;
}

const presentation = (page: Page): Promise<Presentation> => page.evaluate(async () => ((await window.otter) as OtterFixture).state().presentation as Presentation);
const mode = async (page: Page): Promise<Mode> => (await presentation(page)).mode;
const events = (page: Page, type: string) =>
  page.evaluate(async (t) => ((await window.otter) as OtterFixture).events.filter((e) => e.type === t).map((e) => e.payload as { from: Mode; to: Mode; reason?: string }), type);
const button = (page: Page, tag: string) => page.locator(tag).getByRole('button');

/**
 * Waits for a requested mode to be confirmed or refused. Chromium and Firefox must enter it;
 * headless WebKit has the PiP API but may refuse to open a window, which is a valid outcome as
 * long as it is a rollback with a reason (reported as a CI notice).
 */
async function enteredOrDenied(page: Page, target: Mode, browserName: string): Promise<boolean> {
  await expect
    .poll(async () => (await mode(page)) === target || (await events(page, 'presentation-denied')).some((d) => d.to === target), { timeout: 8000 })
    .toBe(true);
  const denied = (await events(page, 'presentation-denied')).find((d) => d.to === target);
  if (denied === undefined) return true;
  expect(browserName, `${target} refused: ${denied.reason}`).toBe('webkit');
  expect(denied.reason).toBeTruthy();
  expect(await presentation(page)).toMatchObject({ mode: 'inline', pending: null });
  console.log(`::notice::${test.info().project.name}: ${target} request refused by the browser (${denied.reason}); rolled back to inline`);
  return false;
}

const iphoneShape = (): void => {
  const none = { configurable: true, get: () => undefined };
  Object.defineProperty(Element.prototype, 'requestFullscreen', none);
  Object.defineProperty(Element.prototype, 'webkitRequestFullscreen', none);
  Object.defineProperty(Document.prototype, 'fullscreenEnabled', { configurable: true, get: () => false });
  Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { configurable: true, get: () => false });
  Object.defineProperty(window, 'documentPictureInPicture', none);
  const proto = HTMLVideoElement.prototype as HTMLVideoElement & Record<string, unknown>;
  // WebKit's own webkitDisplayingFullscreen is a read-only accessor: shadow it on the instance.
  const displaying = (v: HTMLVideoElement, on: boolean): void => void Object.defineProperty(v, 'webkitDisplayingFullscreen', { configurable: true, value: on });
  proto['webkitEnterFullscreen'] = function (this: HTMLVideoElement) {
    displaying(this, true);
    this.dispatchEvent(new Event('webkitbeginfullscreen'));
  };
  proto['webkitExitFullscreen'] = function (this: HTMLVideoElement) {
    displaying(this, false);
    this.dispatchEvent(new Event('webkitendfullscreen'));
  };
};
const isIphone = (): boolean => test.info().project.name === 'emulated-iphone' || process.env['OTTER_IPHONE_SHAPE'] === '1';

const CAPTIONED = { src: '/vod/progressive.mp4', textTracks: [{ src: '/subs/sidecar.vtt', language: 'en', label: 'English', default: true }] };

async function open(page: Page, query = '', play = false, source: object = { src: '/hls-fmp4/master.m3u8' }): Promise<void> {
  if (isIphone()) await page.addInitScript(iphoneShape);
  await page.goto(`/player.html?idle=0${query}`);
  await page.evaluate(
    async ([autoplay, src]) => {
      const o = (await window.otter) as OtterFixture;
      o.dispatch('set-muted', { muted: true });
      o.load(src as Parameters<OtterFixture['load']>[0], { autoplay: autoplay as boolean });
    },
    [play, source] as const,
  );
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().status), { timeout: 20_000 }).toBe('ready');
  if (play) await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().currentTime), { timeout: 15_000 }).toBeGreaterThan(0.3);
}

test.describe('presentation modes', () => {
  test('capabilities match the environment', async ({ page }) => {
    await open(page);
    const caps = (await presentation(page)).capabilities;
    // Independent detection in the page: what each capability claims must exist there.
    const raw = await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement & Record<string, unknown>;
      const el = document.getElementById('player') as HTMLElement & Record<string, unknown>;
      return {
        elementFullscreen: (document.fullscreenEnabled && typeof el.requestFullscreen === 'function') || typeof el['webkitRequestFullscreen'] === 'function',
        videoPip: (document.pictureInPictureEnabled && typeof v.requestPictureInPicture === 'function') || typeof v['webkitSetPresentationMode'] === 'function',
        docPip: (window as unknown as Record<string, unknown>)['documentPictureInPicture'] !== undefined,
      };
    });
    test.info().annotations.push({ type: 'capabilities', description: JSON.stringify(caps) });
    expect(caps.inline).toBe('native');
    expect(caps.theater).toBe('emulated');
    expect(caps.mini).toBe('emulated');
    expect(caps.background).toBe('native');
    expect(caps.fullscreen).toBe(raw.elementFullscreen ? 'native' : 'emulated');
    expect(caps.pip).toBe(raw.videoPip ? 'native' : false);
    expect(caps.docpip).toBe(raw.docPip ? 'native' : false);
    if (isIphone()) expect([caps.fullscreen, caps.docpip]).toEqual(['emulated', false]);
    // The buttons follow: hidden exactly when the mode is unavailable.
    await expect(page.locator('otter-fullscreen-button')).not.toHaveAttribute('data-otter-unsupported');
    if (caps.pip === false && caps.docpip === false) await expect(page.locator('otter-pip-button')).toHaveAttribute('data-otter-unsupported');
  });

  test('fullscreen: click -> confirmed by the browser -> user exit back to inline', async ({ page }) => {
    await open(page);
    const emulated = (await presentation(page)).capabilities.fullscreen === 'emulated';
    await button(page, 'otter-fullscreen-button').click();
    await expect.poll(() => mode(page)).toBe('fullscreen');
    // Covers the window (headless Firefox fullscreens to the screen size, not the viewport).
    const win = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const box = await page.locator('#player').boundingBox();
    expect(box?.width).toBeCloseTo(win.width, -1);
    expect(box?.height).toBeCloseTo(win.height, -1);
    if (emulated) {
      // Pseudo-fullscreen: custom UI stays, the page stops scrolling, Esc leaves.
      await expect(page.locator('#player')).toHaveAttribute('data-otter-emulated', '');
      expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
      await page.locator('#player').press('Escape');
    } else {
      expect(await page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe('player');
      // What Esc / the browser UI does.
      await page.evaluate(() => document.exitFullscreen());
    }
    await expect.poll(() => mode(page)).toBe('inline');
    expect(await events(page, 'presentation-change')).toEqual([
      { from: 'inline', to: 'fullscreen' },
      emulated ? { from: 'fullscreen', to: 'inline' } : { from: 'fullscreen', to: 'inline', reason: 'exited' },
    ]);
  });

  test('fullscreen without a user gesture is refused with a reason and rolled back', async ({ page }) => {
    await open(page);
    test.skip((await presentation(page)).capabilities.fullscreen !== 'native', 'pseudo-fullscreen needs no gesture');
    // Playwright evaluates with a user gesture in Chromium: dispatch from a timer once the
    // transient activation (5 s in Chromium and Firefox) has expired.
    await page.evaluate(async () => {
      const o = (await window.otter) as OtterFixture;
      await new Promise((r) => setTimeout(r, 5500));
      o.dispatch('toggle-fullscreen', {});
    });
    await expect.poll(async () => (await events(page, 'presentation-denied')).length).toBe(1);
    const [denied] = await events(page, 'presentation-denied');
    expect(denied?.from).toBe('inline');
    expect(denied?.to).toBe('fullscreen');
    expect(['noUserGesture', 'notAllowed']).toContain(denied?.reason);
    expect(await presentation(page)).toMatchObject({ mode: 'inline', pending: null });
  });

  test('iPhone system fullscreen is video-only', async ({ page }) => {
    test.skip(!isIphone(), 'iPhone API shape only');
    await open(page);
    await page.locator('#player').click({ position: { x: 5, y: 5 } });
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('request-presentation', { mode: 'fullscreen', system: true }));
    await expect.poll(() => presentation(page)).toMatchObject({ mode: 'fullscreen', videoOnly: true });
    await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement & { webkitExitFullscreen(): void }).webkitExitFullscreen());
    await expect.poll(() => mode(page)).toBe('inline');
  });

  test('theater: layout only, the host widens the player', async ({ page }) => {
    await open(page);
    const before = (await page.locator('#player').boundingBox())?.width ?? 0;
    const theater = button(page, 'otter-theater-button');
    // Narrow (mobile) layouts hide the theater button; the action still works there.
    if (await theater.isVisible()) await theater.click();
    else await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-theater', {}));
    await expect.poll(() => mode(page)).toBe('theater');
    await expect(page.locator('#player')).toHaveAttribute('data-otter-theater', '');
    const wide = (await page.locator('#player').boundingBox())?.width ?? 0;
    if ((page.viewportSize()?.width ?? 0) > 992) expect(wide).toBeGreaterThan(before);
    if (await theater.isVisible()) await expect(theater).toHaveAttribute('aria-pressed', 'true');
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-theater', {}));
    await expect.poll(() => mode(page)).toBe('inline');
    await expect(page.locator('#player')).not.toHaveAttribute('data-otter-theater');
  });

  test('video PiP: entered on click, video-only, closed back to inline (or unsupported)', async ({ page, browserName }) => {
    await open(page, '', true);
    const caps = (await presentation(page)).capabilities;
    if (caps.pip === false) {
      await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('request-presentation', { mode: 'pip' }));
      await expect.poll(async () => (await events(page, 'presentation-denied')).at(-1)?.reason).toBe('unsupported');
      return;
    }
    // WebKit only allows PiP inside the click itself: use the button (narrow layouts hide it, so
    // show it for the test).
    await page.addStyleTag({ content: 'otter-pip-button { display: inline-block !important; }' });
    await button(page, 'otter-pip-button').click();
    if (!(await enteredOrDenied(page, 'pip', browserName))) return;
    await expect.poll(() => presentation(page)).toMatchObject({ mode: 'pip', videoOnly: true, pending: null });
    await page.evaluate(() => document.exitPictureInPicture());
    await expect.poll(() => mode(page)).toBe('inline');
  });

  test('Document PiP keeps playing across the move and returns the player (or unsupported)', async ({ page }) => {
    await open(page, '&pip=document', true);
    if ((await presentation(page)).capabilities.docpip === false) {
      await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('request-presentation', { mode: 'docpip' }));
      await expect.poll(async () => (await events(page, 'presentation-denied')).at(-1)?.reason).toBe('unsupported');
      return;
    }
    // Sample the playhead around the move: it must keep advancing, with no jump.
    await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement;
      const w = window as unknown as { samples: { t: number; at: number; paused: boolean }[] };
      w.samples = [];
      const tick = (): void => {
        w.samples.push({ t: v.currentTime, at: performance.now(), paused: v.paused });
        setTimeout(tick, 50);
      };
      tick();
    });
    // Narrow layouts hide the PiP button; there the action comes from a (gesture-carrying) evaluate.
    const pip = button(page, 'otter-pip-button');
    if (await pip.isVisible()) await pip.click();
    else await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('toggle-pip', {}));
    await expect.poll(() => mode(page)).toBe('docpip');
    expect(await page.evaluate(() => document.getElementById('player'))).toBeNull();
    await page.waitForTimeout(1500);
    const samples = await page.evaluate(() => (window as unknown as { samples: { t: number; at: number; paused: boolean }[] }).samples);
    expect(samples.every((s) => !s.paused)).toBe(true);
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1] as { t: number; at: number };
      const b = samples[i] as { t: number; at: number };
      const wall = (b.at - a.at) / 1000;
      // Never backwards, never more than 0.5 s ahead of the wall clock.
      expect(b.t).toBeGreaterThanOrEqual(a.t);
      expect(b.t - a.t).toBeLessThan(wall + 0.5);
    }
    const last = samples.at(-1) as { t: number };
    expect(last.t - (samples[0] as { t: number }).t).toBeGreaterThan(1);
    await page.evaluate(() => (window as unknown as { documentPictureInPicture: { window: Window } }).documentPictureInPicture.window.close());
    await expect.poll(() => mode(page)).toBe('inline');
    await expect(page.locator('#player video')).toHaveCount(1);
    expect(await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).paused)).toBe(false);
  });

  test('mini window: scrolled out while playing -> corner window, scrolled back -> inline', async ({ page }) => {
    await open(page, '&mini=auto&scroll=1', true);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect.poll(() => mode(page)).toBe('mini');
    await expect(page.locator('[data-otter-placeholder]')).toHaveCount(1);
    const box = await page.locator('#player').boundingBox();
    const viewport = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: innerHeight }));
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeCloseTo(viewport.width - 16, -1);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(viewport.height - 16, -1);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => mode(page)).toBe('inline');
    await expect(page.locator('[data-otter-placeholder]')).toHaveCount(0);
    // The `i` hotkey toggles it by hand.
    await page.locator('#player').press('i');
    await expect.poll(() => mode(page)).toBe('mini');
    await page.locator('#player').press('i');
    await expect.poll(() => mode(page)).toBe('inline');
  });

  test('background: entered when the page is hidden, left when visible; never by request', async ({ page }) => {
    await open(page);
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('request-presentation', { mode: 'background' }));
    await expect.poll(async () => (await events(page, 'presentation-denied')).at(-1)).toEqual({ from: 'inline', to: 'background', reason: 'unsupported' });
    // Headless pages are always visible: drive visibilitychange the way a tab switch would.
    const visibility = (state: 'hidden' | 'visible') =>
      page.evaluate((s) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    await visibility('hidden');
    await expect.poll(() => mode(page)).toBe('background');
    await visibility('visible');
    await expect.poll(() => mode(page)).toBe('inline');
  });

  test('MediaSession: metadata, playback state and handlers', async ({ page }) => {
    await open(page, '', true);
    const ms = await page.evaluate(() => ({ title: navigator.mediaSession.metadata?.title ?? null, state: navigator.mediaSession.playbackState }));
    expect(ms).toEqual({ title: 'Otter Player Demo', state: 'playing' });
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('pause', undefined));
    await expect.poll(() => page.evaluate(() => navigator.mediaSession.playbackState)).toBe('paused');
  });
});

test.describe('native TextTrack fallback (ADR-007 §6)', () => {
  /** The mirrored track on the <video>: mode and cue count, null when none was created. */
  const nativeTrack = (page: Page) =>
    page.evaluate(() => {
      const t = (document.querySelector('video') as HTMLVideoElement).textTracks[0];
      return t === undefined ? null : { mode: t.mode, cues: t.cues?.length ?? 0, label: t.label };
    });
  const customCues = (page: Page) => page.locator('[data-otter-cues] [data-cue-id]').count();

  test('video-only modes show captions as a native TextTrack, Otter renders them again after', async ({ page, browserName }) => {
    await open(page, '', true, CAPTIONED);
    const caps = (await presentation(page)).capabilities;
    const system = isIphone();
    test.skip(!system && caps.pip === false, 'no video PiP here');
    await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().textStatus)).toBe('ready');
    // The sample's cues cover 0-8 s: Otter draws them inline.
    await expect.poll(() => customCues(page)).toBeGreaterThan(0);
    expect(await nativeTrack(page)).toBeNull();
    if (system) await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('request-presentation', { mode: 'fullscreen', system: true }));
    else {
      // A real click: WebKit only allows PiP inside it.
      await page.addStyleTag({ content: 'otter-pip-button { display: inline-block !important; }' });
      await button(page, 'otter-pip-button').click();
      if (!(await enteredOrDenied(page, 'pip', browserName))) return;
    }
    await expect.poll(() => presentation(page)).toMatchObject({ videoOnly: true });
    await expect.poll(() => nativeTrack(page)).toMatchObject({ mode: 'showing', label: 'English' });
    expect((await nativeTrack(page))?.cues).toBeGreaterThan(0);
    expect(await customCues(page)).toBe(0);
    if (system) await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement & { webkitExitFullscreen(): void }).webkitExitFullscreen());
    else await page.evaluate(() => document.exitPictureInPicture());
    await expect.poll(() => presentation(page)).toMatchObject({ mode: 'inline', videoOnly: false });
    await expect.poll(() => nativeTrack(page)).toMatchObject({ mode: 'hidden' });
    await expect.poll(() => customCues(page)).toBeGreaterThan(0);
  });

  test('mode: native always uses the native TextTrack', async ({ page }) => {
    await open(page, '&text=native', true, CAPTIONED);
    await expect.poll(() => nativeTrack(page)).toMatchObject({ mode: 'showing', label: 'English' });
    await page.waitForTimeout(500);
    expect(await customCues(page)).toBe(0);
  });
});

test.describe('cast and airplay buttons', () => {
  test('Cast: shown when a receiver is available, the click prompts inside the gesture, state follows', async ({ page }) => {
    // Stand-in Remote Playback API (no receivers in CI): records whether prompt() ran with activation.
    await page.addInitScript(() => {
      const remote = Object.assign(new EventTarget(), {
        state: 'disconnected',
        prompts: [] as boolean[],
        watchAvailability: (cb: (a: boolean) => void) => (setTimeout(() => cb(true), 10), Promise.resolve(1)),
        cancelWatchAvailability: () => Promise.resolve(),
        prompt() {
          remote.prompts.push((navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true);
          return Promise.resolve();
        },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'remote', { configurable: true, get: () => remote });
      Object.defineProperty(HTMLMediaElement.prototype, 'webkitShowPlaybackTargetPicker', { configurable: true, get: () => undefined });
      (window as unknown as { fakeRemote: typeof remote }).fakeRemote = remote;
    });
    await open(page);
    const cast = button(page, 'otter-cast-button');
    await expect(cast).toBeVisible();
    await expect(page.locator('otter-airplay-button')).toHaveAttribute('data-otter-unsupported');
    await cast.click();
    expect(await page.evaluate(() => (window as unknown as { fakeRemote: { prompts: boolean[] } }).fakeRemote.prompts)).toEqual([true]);
    await page.evaluate(() => {
      const r = (window as unknown as { fakeRemote: EventTarget & { state: string } }).fakeRemote;
      r.state = 'connected';
      r.dispatchEvent(new Event('connect'));
    });
    await expect(cast).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().cast)).toBe('connected');
  });

  test('AirPlay: shown when a target is available, the click opens the picker', async ({ page }) => {
    await page.addInitScript(() => {
      const calls: boolean[] = [];
      (window as unknown as { airplayCalls: boolean[] }).airplayCalls = calls;
      (HTMLMediaElement.prototype as unknown as Record<string, unknown>)['webkitShowPlaybackTargetPicker'] = () =>
        calls.push((navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive ?? true);
    });
    await open(page);
    await expect(page.locator('otter-airplay-button')).toHaveAttribute('data-otter-unsupported');
    await page.evaluate(() => {
      const v = document.querySelector('video') as HTMLVideoElement;
      v.dispatchEvent(Object.assign(new Event('webkitplaybacktargetavailabilitychanged'), { availability: 'available' }));
    });
    const airplay = button(page, 'otter-airplay-button');
    await expect(airplay).toBeVisible();
    await expect(page.locator('otter-cast-button')).toHaveAttribute('data-otter-unsupported');
    await airplay.click();
    expect(await page.evaluate(() => (window as unknown as { airplayCalls: boolean[] }).airplayCalls)).toEqual([true]);
  });
});
