// Own pipeline with input chunks that are views into larger buffers (?chunks=views): every frame
// reaches MSE once and in order, captions appear once. Guards the vendored hls.js TS demuxer fix
// (vendor/hls.js UPSTREAM.json localChanges; docs/reports/m3/hlsjs-byteoffset-evidence.md).

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

/** Records, per SourceBuffer, the frames appended (trun sample counts) and each moof's tfdt (decode time). */
const recordAppends = (): void => {
  const w = window as unknown as { appends: { type: string; frames: number; tfdt: number[] }[] };
  w.appends = [];
  const add = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
    const sb = add.call(this, mime);
    const rec = { type: mime.split('/')[0] ?? mime, frames: 0, tfdt: [] as number[] };
    w.appends.push(rec);
    const append = sb.appendBuffer.bind(sb);
    sb.appendBuffer = (data: BufferSource) => {
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      // Walk moof > traf > {tfdt, trun}; mdat payloads are skipped by box size.
      const walk = (start: number, end: number): void => {
        for (let o = start; o + 8 <= end; ) {
          const size = v.getUint32(o);
          const type = String.fromCharCode(u8[o + 4]!, u8[o + 5]!, u8[o + 6]!, u8[o + 7]!);
          if (size < 8) return;
          if (type === 'moof' || type === 'traf') walk(o + 8, o + size);
          if (type === 'tfdt') rec.tfdt.push(u8[o + 8] === 1 ? Number(v.getBigUint64(o + 12)) : v.getUint32(o + 12));
          if (type === 'trun') rec.frames += v.getUint32(o + 12);
          o += size;
        }
      };
      walk(0, u8.byteLength);
      return append(data);
    };
    return sb;
  };
};

async function run(page: Page, src: string, views: boolean) {
  await page.addInitScript(recordAppends);
  await page.goto(`/player.html?idle=0&pipeline=otter${views ? '&chunks=views' : ''}`);
  await page.evaluate(async (url) => {
    const o = (await window.otter) as OtterFixture;
    o.dispatch('set-muted', { muted: true });
    o.load({ src: url }, { autoplay: true });
  }, src);
  await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().status), { timeout: 15_000 }).toBe('ready');
  const cues = new Set<string>();
  if (src.includes('/cc/')) {
    await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().textTracks.length), { timeout: 10_000 }).toBeGreaterThan(0);
    await page.evaluate(async () => ((await window.otter) as OtterFixture).dispatch('select-text-track', { id: 'inband:cc1' }));
  }
  // Play to the end, collecting the cues on screen.
  for (let i = 0; i < 60; i++) {
    for (const id of await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-cue-id]')].map((e) => `${e.dataset['cueId']}`))) cues.add(id);
    if (await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).ended)) break;
    await page.waitForTimeout(250);
  }
  const appends = await page.evaluate(() => (window as unknown as { appends: { type: string; frames: number; tfdt: number[] }[] }).appends);
  const video = appends.find((a) => a.type === 'video');
  const backwards = (video?.tfdt ?? []).filter((t, i, all) => i > 0 && t <= (all[i - 1] as number)).length;
  const textTracks = await page.evaluate(async () => ((await window.otter) as OtterFixture).state().textTracks.map((t) => t.id));
  return { videoFrames: video?.frames ?? 0, fragments: video?.tfdt.length ?? 0, backwards, cues: [...cues], textTracks };
}

for (const [name, src] of [
  ['cn-vod-ts', '/ts/clip.ts'],
  ['608 TS', '/cc/clip.ts'],
] as const) {
  test(`${name} with view chunks: each frame once and in order, captions once`, async ({ browser }) => {
    const copies = await run(await browser.newPage(), src, false);
    const views = await run(await browser.newPage(), src, true);
    test.info().annotations.push({ type: 'evidence', description: JSON.stringify({ copies, views }) });
    console.log(`EVIDENCE ${test.info().project.name} ${name} ${JSON.stringify({ copies, views })}`);
    // 8 s at 25 fps; fragment boundaries follow the network chunking, so only frames are compared.
    expect(copies.videoFrames).toBe(200);
    expect(views.videoFrames).toBe(200);
    expect(views.backwards).toBe(0);
    expect(views.cues).toEqual(copies.cues);
    if (src.includes('/cc/')) expect(views.cues).toHaveLength(1);
  });
}
