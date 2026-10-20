// Multi-view wall in the player shell (ADR-008 §7, M4 acceptance): 16 streams of 720p HEVC on
// one shared canvas (one WebGL2 context, rendered in a Worker where possible), decoded in the
// shared Worker pool. Pictures are checked per tile from the frame number painted into the clip
// (generate-frames.sh: 96 px blocks across the top of a 1280x720 picture).

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { WallFixture } from './site/player.ts';

const FPS = 30;
const covering = (t: number): number => Math.floor(t * FPS + 0.0005 * FPS + 1e-6);

const ciNotice = (text: string): void => {
  mkdirSync('test-results', { recursive: true });
  appendFileSync('test-results/ci-notices.txt', `${test.info().project.name}: ${text}\n`);
};

const wall = (page: Page) => ({
  eval: <T>(fn: (w: WallFixture) => T | Promise<T>): Promise<T> => page.evaluate(async (src) => {
    const w = await (window.wall as Promise<WallFixture>);
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return (new Function('w', `return (${src})(w)`) as (w: WallFixture) => T)(w);
  }, fn.toString()),
});

/** Frame number in each of the wall's `cols` x `rows` tiles (or the whole wall: cols = rows = 1). */
async function framesOnWall(page: Page, cols: number, rows: number): Promise<number[]> {
  // The bars' gradients would darken the blocks, and a paused focused tile keeps them shown (as it
  // should): hide them for the screenshot only.
  const style = await page.addStyleTag({ content: '[data-otter-top], [data-otter-controls], [data-otter-center] { visibility: hidden !important; }' });
  const png = (await page.locator('[data-otter-multiview]').screenshot({ animations: 'disabled' })).toString('base64');
  await style.evaluate((el) => (el as Element).remove());
  return page.evaluate(
    async ([b64, c, r]) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      const tw = img.width / c;
      const th = img.height / r;
      const out: number[] = [];
      for (let row = 0; row < r; row++) {
        for (let col = 0; col < c; col++) {
          let bits = 0;
          for (let i = 0; i < 10; i++) {
            const d = ctx.getImageData(Math.floor(col * tw + ((i * 96 + 48) / 1280) * tw), Math.floor(row * th + (48 / 720) * th), 1, 1).data;
            if ((d[0] as number) + (d[1] as number) + (d[2] as number) > 384) bits |= 1 << i;
          }
          out.push(bits);
        }
      }
      return out;
    },
    [png, cols, rows] as const,
  );
}

/** Opens a wall of `count` streams and waits until the first 16 play (more wait for a decoder). */
async function open(page: Page, count: number): Promise<void> {
  await page.goto(`/player.html?multiview=${count}&idle=0`);
  await expect
    .poll(() => page.evaluate(async () => (await (window.wall as Promise<WallFixture>)).tiles().filter((t) => t.status === 'ready').length), { timeout: 60_000 })
    .toBe(Math.min(16, count));
}

// A benchmark (@bench): 16 software-decoded 720p streams need the machine to themselves. Run alone,
// one worker: pnpm e2e --project=desktop-chrome --grep @bench --workers=1 (CI: its own step).
test('16 x 720p HEVC on one canvas: every tile plays its stream, the main thread keeps its frames @bench', async ({ page }, info) => {
  test.setTimeout(180_000);
  test.skip(info.project.name !== 'desktop-chrome', 'the M4 acceptance runs in desktop Chrome');
  const cores = await page.evaluate(() => navigator.hardwareConcurrency);
  if (cores < 8) {
    ciNotice(`multiview bench skipped: ${cores} cores here, 16 software-decoded 720p HEVC streams need about 3 cores of decoding plus rendering (run it on an 8+ core machine)`);
    test.skip(true, `${cores} cores`);
  }
  await open(page, 16);
  const w = wall(page);
  const kind = await w.eval((x) => x.kind);
  // Warm up, then 10 s of measurement (the 10 s clip loops).
  await page.waitForTimeout(2000);
  const before = await w.eval((x) => ({ tiles: x.tiles(), pool: x.pool(), at: performance.now() }));
  const main = await w.eval((x) => x.measure(10_000));
  const after = await w.eval((x) => ({ tiles: x.tiles(), pool: x.pool(), at: performance.now() }));
  const wallMs = after.at - before.at;

  const rows = after.tiles.map((t, i) => {
    const b = before.tiles[i] as (typeof before.tiles)[number];
    const slot = after.pool.slots.find((s) => s.label.includes('wasm') || s.label.startsWith('hvc')) ? after.pool.slots[i] : undefined;
    const bSlot = before.pool.slots[i];
    const advanced = t.currentTime - b.currentTime + 10 * (t.loops - b.loops);
    const decoded = (slot?.frames ?? 0) - (bSlot?.frames ?? 0);
    const cpu = ((slot?.busyMs ?? 0) - (bSlot?.busyMs ?? 0)) / wallMs;
    return {
      tile: t.label,
      backend: t.backend,
      worker: slot?.worker,
      advancedS: Math.round(advanced * 100) / 100,
      decodedFrames: decoded,
      cpuPercentOfOneCore: Math.round(cpu * 1000) / 10,
      droppedByClock: t.dropped - b.dropped,
      replacedOnCanvas: t.replaced - b.replaced,
      errors: t.errors.filter((e) => e !== 'codecUnsupported'),
    };
  });
  const report = { project: info.project.name, cores, kind, mainThread: main, wallMs: Math.round(wallMs), workers: after.pool.workers, streams: rows };
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/multiview-${info.project.name}.json`, JSON.stringify(report, null, 2));
  info.attach('multiview.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  const worst = rows.reduce((m, r) => ({ cpu: Math.max(m.cpu, r.cpuPercentOfOneCore), lost: Math.max(m.lost, r.droppedByClock + r.replacedOnCanvas), slow: Math.min(m.slow, r.advancedS) }), { cpu: 0, lost: 0, slow: Infinity });
  ciNotice(`multiview 16 x 720p HEVC (${rows[0]?.backend}, ${after.pool.workers} workers, ${kind}): main thread ${main.frames} rAF in 10 s, ${main.over20} > 20 ms, ${main.over34} > 34 ms, longest ${Math.round(main.longest)} ms, ${main.longTasks} long tasks; per stream worst CPU ${worst.cpu}% of a core, worst lost frames ${worst.lost}, slowest ${worst.slow} s played`);

  for (const r of rows) {
    expect(r.errors, r.tile).toEqual([]);
    // Real time: each stream played (nearly) all 10 s.
    expect(r.advancedS, r.tile).toBeGreaterThan(9);
    // Frames lost (skipped by the clock or never drawn): at most 5% of 300.
    expect(r.droppedByClock + r.replacedOnCanvas, r.tile).toBeLessThanOrEqual(15);
  }
  // The main thread keeps its frame rate: no long task, no frame missed by two vsyncs.
  expect(main.longTasks).toBe(0);
  expect(main.over34).toBe(0);
  expect(main.over20 / main.frames).toBeLessThan(0.02);

  // Every viewport shows its own stream: paused, each tile's picture is the frame of its clock.
  await page.evaluate(async () => {
    const x = await (window.wall as Promise<WallFixture>);
    const tiles = x.tiles();
    for (let i = 0; i < tiles.length; i++) x.dispatchTo(i, 'pause');
  });
  const times = await w.eval((x) => x.tiles().map((t) => t.currentTime));
  await expect.poll(() => framesOnWall(page, 4, 4), { timeout: 10_000 }).toEqual(times.map(covering));
});

test('focus: one tile has sound and the controls; double-click: local fullscreen and back', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, 4);
  const w = wall(page);
  expect(await w.eval((x) => x.focused())).toBe(0);
  expect(await w.eval((x) => x.tiles().map((t) => t.muted))).toEqual([false, true, true, true]);
  // Tile 2 is top right; click clear of the bars and the centre buttons (small players put them
  // over the tiles).
  const tile = page.locator('[data-otter-multiview-tile="2"]');
  const box = (await tile.boundingBox()) as { width: number; height: number };
  const at = { position: { x: box.width * 0.85, y: box.height * 0.6 } };
  // A click focuses it: only it is audible, the shell's controls show its state.
  await tile.click(at);
  expect(await w.eval((x) => x.focused())).toBe(1);
  expect(await w.eval((x) => x.tiles().map((t) => t.muted))).toEqual([true, false, true, true]);
  await expect(tile).toHaveAttribute('aria-pressed', 'true');
  // The shell's play button acts on the focused tile only.
  await page.locator('otter-play-button:visible').first().click();
  await expect.poll(() => w.eval((x) => x.tiles().map((t) => t.paused))).toEqual([false, true, false, false]);
  expect(await w.eval((x) => x.shellState().paused)).toBe(true);
  // Double-click: it fills the wall (its picture at full size), the others are hidden.
  await tile.dblclick(at);
  expect(await w.eval((x) => x.expanded())).toBe(1);
  const t2 = await w.eval((x) => (x.tiles()[1] as { currentTime: number }).currentTime);
  // The render Worker draws the new layout on its next render (later on a loaded machine).
  await expect.poll(() => framesOnWall(page, 1, 1), { timeout: 10_000 }).toEqual([covering(t2)]);
  await expect(page.locator('[data-otter-multiview-tile="1"]')).toBeHidden();
  // And back to the grid.
  await tile.dblclick(at);
  expect(await w.eval((x) => x.expanded())).toBe(-1);
  await expect(page.locator('[data-otter-multiview-tile="1"]')).toBeVisible();
  // Keyboard: Enter focuses, Shift+Enter expands.
  await page.locator('[data-otter-multiview-tile="3"]').focus();
  await page.keyboard.press('Enter');
  expect(await w.eval((x) => x.focused())).toBe(2);
  await page.keyboard.press('Shift+Enter');
  expect(await w.eval((x) => x.expanded())).toBe(2);
});

test('every viewport of the shared canvas shows its own stream', async ({ page }, info) => {
  test.setTimeout(120_000);
  await open(page, 4);
  const w = wall(page);
  await page.waitForTimeout(1500);
  // Paused at four different positions (off keyframes), each viewport must show its own.
  await page.evaluate(async () => {
    const x = await (window.wall as Promise<WallFixture>);
    x.tiles().forEach((_, i) => x.dispatchTo(i, 'pause'));
    await Promise.all(x.tiles().map((_, i) => x.seekTile(i, 0.9 + i * 2.13)));
  });
  const times = await w.eval((x) => x.tiles().map((t) => t.currentTime));
  expect(new Set(times.map(covering)).size).toBe(4);
  await expect.poll(() => framesOnWall(page, 2, 2), { timeout: 10_000 }).toEqual(times.map(covering));
  ciNotice(`multiview 4 tiles on ${await w.eval((x) => x.kind)}: each viewport shows its own stream (${info.project.name})`);
});

test('a 17th stream waits for a decoder slot, says why, and starts when one frees', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, 17);
  const w = wall(page);
  // Whichever stream asked last waits (17 load at once): exactly one, told why.
  const tiles = await w.eval((x) => x.tiles());
  const waiting = tiles.filter((t) => t.status === 'loading');
  expect(waiting).toHaveLength(1);
  const queued = waiting[0] as (typeof tiles)[number];
  expect(queued.errors).toContain('decoderQueued');
  expect(queued.route?.steps.map((s) => s.reason)).toContainEqual(expect.stringMatching(/^decoder queued: 16 decoders busy \(pool limit\)/));
  expect((await w.eval((x) => x.pool())).queued).toBe(1);
  // A stream leaves: the waiting one gets its decoder and plays.
  const index = tiles.indexOf(queued);
  await w.eval((x) => x.remove(x.tiles().findIndex((t) => t.status === 'ready')));
  await expect.poll(() => w.eval((x) => x.tiles().every((t) => t.status === 'ready')), { timeout: 30_000 }).toBe(true);
  expect((await w.eval((x) => x.pool())).queued).toBe(0);
  void index;
});
