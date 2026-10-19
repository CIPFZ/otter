// CMCD on the wire (ADR-005 §2): real engines in a real browser, requests inspected by Playwright.
// Every engine must send the same session keys; media requests carry ot / br / bl.

import type { Request } from '@playwright/test';
import { expect, test } from './fixtures';
import type { OtterFixture } from './site/player.ts';

const SOURCES = [
  { name: 'hls.js', src: '/hls-fmp4/master.m3u8', media: /\.m4s/, manifest: /\.m3u8/ },
  { name: 'Shaka', src: '/dash/manifest.mpd', media: /chunk-.*\.m4s/, manifest: /\.mpd/ },
  { name: 'mpegts.js', src: '/live/stream.flv', media: /stream\.flv/, manifest: undefined, live: true },
] as const;

/** CMCD key/value pairs of a request, from the query parameter or the four headers. */
async function cmcdOf(request: Request, mode: 'query' | 'headers'): Promise<Record<string, string>> {
  let raw: string;
  if (mode === 'query') {
    raw = new URL(request.url()).searchParams.get('CMCD') ?? '';
  } else {
    const h = await request.allHeaders();
    raw = ['cmcd-request', 'cmcd-object', 'cmcd-status', 'cmcd-session'].map((k) => h[k] ?? '').filter((v) => v !== '').join(',');
  }
  const out: Record<string, string> = {};
  for (const part of raw.split(',').filter((p) => p !== '')) {
    const [k, v] = part.split('=');
    if (k !== undefined) out[k] = v ?? 'true';
  }
  return out;
}

for (const mode of ['query', 'headers'] as const) {
  for (const s of SOURCES) {
    test(`CMCD ${mode} · ${s.name}`, async ({ page }) => {
      const requests: Request[] = [];
      page.on('request', (r) => requests.push(r));
      await page.goto(`/player.html?cmcd=${mode}`);
      await page.evaluate(
        async ({ src, live }) => {
          const o = (await window.otter) as OtterFixture;
          o.dispatch('set-muted', { muted: true });
          o.load({ src, ...(live ? { live: true } : {}) }, { autoplay: true });
        },
        { src: s.src, live: 'live' in s },
      );
      await expect.poll(async () => page.evaluate(async () => ((await window.otter) as OtterFixture).state().qoe.ttff), { timeout: 30_000 }).not.toBeNull();

      const media = requests.filter((r) => s.media.test(r.url()));
      expect(media.length, 'media requests seen').toBeGreaterThan(0);
      for (const r of media) {
        const keys = await cmcdOf(r, mode);
        expect(keys, r.url()).toMatchObject({ sid: '"otter-e2e"', cid: '"fixture"' });
        expect(['v', 'av', 'a', 'i']).toContain(keys['ot']);
        if (keys['ot'] !== 'i') expect(keys['bl'], `bl on ${r.url()}`).toBeDefined();
      }
      if (s.manifest !== undefined) {
        const manifests = requests.filter((r) => s.manifest.test(r.url()));
        expect(manifests.length).toBeGreaterThan(0);
        for (const r of manifests) expect(await cmcdOf(r, mode)).toMatchObject({ ot: 'm', sid: '"otter-e2e"' });
      }
      // At least one video request carries the encoded bitrate (not for the single-rendition FLV).
      if (s.name !== 'mpegts.js') {
        const brs = await Promise.all(media.map(async (r) => (await cmcdOf(r, mode))['br']));
        expect(brs.some((b) => b !== undefined)).toBe(true);
      }
      // Playback is unaffected.
      expect(await page.evaluate(async () => ((await window.otter) as OtterFixture).state().error)).toBeNull();
    });
  }
}
