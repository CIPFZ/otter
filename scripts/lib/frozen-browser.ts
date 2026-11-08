// The public site distributes the verified first-release bytes, independent of the host OS.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const VERSION = '0.1.0-beta.0';
const SOURCE_COMMIT = '56893d2dd70f370be4e1828f4753f560e9ecc804';
const TARBALL_URL = 'https://registry.npmjs.org/@otter-player/cdn/-/cdn-0.1.0-beta.0.tgz';
// Pinned independently of the provenance file: changing both metadata and bytes must still fail.
const INTEGRITY = 'sha512-K13xGx0mRQAB6hKIVSJxbXEPQGGvhlQsNXGQj1CJ2VNC/ANXQUwUoflDYaafXv4RbdSLLRFcZxsHePSD19Su3w==';

export interface FrozenBrowserProvenance {
  readonly package: string;
  readonly version: string;
  readonly sourceCommit: string;
  readonly tarball: string;
  readonly integrity: string;
  readonly sha512: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface FrozenBrowser {
  readonly version: string;
  readonly sourceCommit: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly provenance: FrozenBrowserProvenance;
}

function provenanceFile(file: string): FrozenBrowserProvenance {
  const input: unknown = JSON.parse(readFileSync(file, 'utf8'));
  assert(input !== null && typeof input === 'object' && !Array.isArray(input), 'Invalid browser provenance');
  const value = input as Record<string, unknown>;
  assert(value['package'] === '@otter-player/cdn' && value['version'] === VERSION, 'Unexpected frozen package/version');
  assert(value['sourceCommit'] === SOURCE_COMMIT && value['tarball'] === TARBALL_URL, 'Unexpected frozen browser source');
  assert(value['integrity'] === INTEGRITY, 'Frozen integrity does not match the independently pinned npm artifact');
  const sha512 = value['sha512'], sha256 = value['sha256'], bytes = value['bytes'];
  assert(typeof sha512 === 'string' && /^[a-f0-9]{128}$/.test(sha512), 'Invalid SHA-512 provenance');
  assert(typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256), 'Invalid SHA-256 provenance');
  assert(typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0, 'Invalid archive size');
  return { package: '@otter-player/cdn', version: VERSION, sourceCommit: SOURCE_COMMIT, tarball: TARBALL_URL, integrity: INTEGRITY, sha512, sha256, bytes };
}

/** Read the pinned npm archive's regular USTAR files in memory; never extract paths to disk. */
function readTar(data: Buffer): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  const string = (bytes: Buffer): string => bytes.toString('utf8').replace(/\0.*$/s, '');
  const octal = (bytes: Buffer): number => {
    const text = string(bytes).trim();
    assert(/^[0-7]+$/.test(text), 'Unsupported TAR number');
    const value = Number.parseInt(text, 8);
    assert(Number.isSafeInteger(value) && value >= 0, 'Invalid TAR number');
    return value;
  };
  let at = 0;
  while (at + 512 <= data.length) {
    const header = data.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) {
      assert(at + 1024 <= data.length && data.subarray(at).every((byte) => byte === 0), 'Invalid TAR end padding');
      return result;
    }
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : (header[i] as number);
    assert.equal(checksum, octal(header.subarray(148, 156)), 'TAR header checksum mismatch');
    assert(header[156] === 48, 'Only regular files are allowed in the frozen archive');
    assert(string(header.subarray(257, 263)) === 'ustar', 'Unsupported TAR header');
    const prefix = string(header.subarray(345, 500));
    const name = (prefix === '' ? '' : prefix + '/') + string(header.subarray(0, 100));
    assert(name.startsWith('package/') && !name.includes('\\') && !name.includes(':') && name.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'Unsafe TAR path: ' + name);
    assert(!result.has(name), 'Duplicate TAR path: ' + name);
    const size = octal(header.subarray(124, 136));
    const end = at + 512 + size;
    const next = at + 512 + Math.ceil(size / 512) * 512;
    assert(end <= data.length && next <= data.length, 'Truncated TAR file: ' + name);
    result.set(name, data.subarray(at + 512, end));
    at = next;
  }
  throw new Error('Missing TAR end records');
}

/** Verify the frozen bytes before reading them. An alternate directory is useful for integrity tests. */
export function readFrozenBrowser(assetsDir = join(import.meta.dirname, '../../site-assets/browser')): FrozenBrowser {
  const provenance = provenanceFile(join(assetsDir, VERSION + '.provenance.json'));
  const archive = readFileSync(join(assetsDir, VERSION + '.tgz'));
  assert.equal(archive.length, provenance.bytes, 'Frozen browser archive size mismatch');
  const sha512 = createHash('sha512').update(archive).digest();
  assert.equal('sha512-' + sha512.toString('base64'), INTEGRITY, 'Frozen browser archive integrity mismatch');
  assert.equal(sha512.toString('hex'), provenance.sha512, 'Frozen SHA-512 provenance mismatch');
  assert.equal(createHash('sha256').update(archive).digest('hex'), provenance.sha256, 'Frozen SHA-256 provenance mismatch');
  const entries = readTar(gunzipSync(archive, { maxOutputLength: 16 * 1024 * 1024 }));
  const manifestBytes = entries.get('package/package.json');
  assert(manifestBytes !== undefined, 'Frozen archive has no package manifest');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as { name?: unknown; version?: unknown };
  assert(manifest.name === provenance.package && manifest.version === VERSION, 'Frozen manifest does not match provenance');
  const files = new Map<string, Buffer>();
  for (const [name, bytes] of entries) {
    if (name === 'package/package.json' || name === 'package/README.md') continue;
    if (name === 'package/LICENSE' || name === 'package/NOTICE') files.set(name.slice('package/'.length), bytes);
    else {
      assert(/^package\/dist\/otter-(basic|vod)\/(?:chunks\/[A-Za-z0-9_.-]+\.js|otter-(basic|vod)\.(?:esm\.js|css))$/.test(name), 'Unexpected frozen package file: ' + name);
      files.set(name.slice('package/dist/'.length), bytes);
    }
  }
  assert(entries.size === 101 && files.size === 99 && files.has('LICENSE') && files.has('NOTICE'), 'Incomplete frozen browser distribution');
  for (const preset of ['basic', 'vod']) {
    assert(files.has('otter-' + preset + '/otter-' + preset + '.esm.js') && files.has('otter-' + preset + '/otter-' + preset + '.css'), 'Missing frozen preset entry: ' + preset);
  }
  return { version: VERSION, sourceCommit: SOURCE_COMMIT, files, provenance };
}
