import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notice, releaseFiles, thirdParty } from '../release-files.ts';

const pkg = (dir: string): string => join(import.meta.dirname, '../../packages', dir);

describe('release files (ADR-014 §4)', () => {
  it('lists the copied code (src/vendor UPSTREAM.json) and the code bundled into dist (otter.bundle)', () => {
    expect(thirdParty(pkg('pipeline')).map((x) => `${x.upstream.project} ${x.upstream.license}`)).toEqual(['dash.js BSD-3-Clause', 'hls.js Apache-2.0', 'mpegts.js Apache-2.0', 'hls.js Apache-2.0']);
    expect(thirdParty(pkg('text')).map((x) => x.upstream.project)).toEqual(['imsc', 'sax']);
    expect(thirdParty(pkg('ui-core')).map((x) => x.upstream.project)).toEqual(['lucide']);
    expect(notice('@otter-player/core', pkg('core'))).toBeUndefined();
    const ui = notice('@otter-player/ui-core', pkg('ui-core')) ?? '';
    expect(ui).toContain('- lucide (https://www.npmjs.com/package/lucide, 1.59.0): ISC; bundled from npm into dist/');
    expect(ui).toContain('ISC License');
  });

  it('gives every published package a LICENSE and none to a placeholder', () => {
    const files = [...releaseFiles().keys()];
    expect(files).toContain(join('packages', 'core', 'LICENSE'));
    expect(files).toContain(join('packages', 'demux-mediabunny', 'NOTICE'));
    expect(files.some((f) => f.startsWith(join('packages', 'decoder-wasm-hevc')))).toBe(false);
    expect(files.some((f) => f.startsWith(join('packages', 'plugin-cast')))).toBe(false);
  });
});
