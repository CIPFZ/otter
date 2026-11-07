import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { notice, releaseFileMatches, releaseFiles, thirdParty } from '../release-files.ts';

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

  it('accepts a generated NOTICE checked out with either LF or CRLF line endings', () => {
    const generated = notice('@otter-player/text', pkg('text'));
    if (generated === undefined) throw new Error('The text package must have a NOTICE');
    const lf = generated.replace(/\r\n/g, '\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(releaseFileMatches(crlf, generated)).toBe(true);
    expect(releaseFileMatches(lf, crlf)).toBe(true);
    expect(releaseFileMatches(generated, lf)).toBe(true);
  });

  it.each([
    ['missing file', undefined],
    ['changed content', 'Package\r\nCopyright 2025.\r\n'],
    ['missing line', 'Package\r\n'],
    ['trailing spaces', 'Package \r\nCopyright 2026.\r\n'],
    ['missing final newline', 'Package\r\nCopyright 2026.'],
    ['standalone carriage return', 'Package\rCopyright 2026.\r'],
  ])('still rejects a stale release file: %s', (_reason, actual) => {
    expect(releaseFileMatches(actual, 'Package\nCopyright 2026.\n')).toBe(false);
  });
});
