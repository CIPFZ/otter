// LICENSE and NOTICE of every published package (ADR-014 §4). Each package ships the repository's
// Apache-2.0 LICENSE; a package that carries third-party code also ships a NOTICE listing it, with
// the upstream license texts:
// - copied code (L2 / L3): the package's `src/vendor/*/UPSTREAM.json` (project, repo, pinned commit,
//   license);
// - code bundled into its dist (`otter.bundle` in package.json): `@otter-vendor/*` from
//   `vendor/*/UPSTREAM.json`, npm packages by name.
// The upstream texts live in tooling/licenses/<project>.txt (fetched once from the pinned commit,
// or copied from node_modules for npm packages). Placeholders (`private: true`) get neither.
//
//   node scripts/release-files.ts           write the files
//   node scripts/release-files.ts --check   fail when one is missing or stale (pnpm check)

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

interface Upstream {
  readonly project: string;
  readonly repo: string;
  readonly commit: string;
  readonly tag?: string;
  readonly license: string;
  readonly level?: string;
}

/** npm packages bundled into a dist: their license (the text is tooling/licenses/<name>.txt). */
const NPM_LICENSES: Readonly<Record<string, string>> = { imsc: 'BSD-2-Clause', sax: 'ISC', lucide: 'ISC' };

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** The installed version of `name`, resolved from the package or from another bundled dependency (sax under imsc). */
function installedVersion(pkgDir: string, name: string, bundled: readonly string[]): string {
  for (const from of [join(pkgDir, 'package.json'), ...bundled.filter((b) => b !== name && !b.startsWith('@otter-vendor/')).map((b) => createRequire(join(pkgDir, 'package.json')).resolve(`${b}/package.json`))]) {
    try {
      return readJson<{ version: string }>(createRequire(from).resolve(`${name}/package.json`)).version;
    } catch {
      // not resolvable from there
    }
  }
  throw new Error(`cannot find the installed version of ${name} (bundled into ${pkgDir})`);
}

/** The third-party code in a package, with where it sits. */
export function thirdParty(pkgDir: string): { upstream: Upstream; where: string; text: string }[] {
  const out: { upstream: Upstream; where: string; text: string }[] = [];
  const text = (project: string): string => {
    const file = join(root, 'tooling/licenses', `${project}.txt`);
    if (!existsSync(file)) throw new Error(`tooling/licenses/${project}.txt is missing (the license text of ${project})`);
    return readFileSync(file, 'utf8').trim();
  };
  const vendorDir = join(pkgDir, 'src/vendor');
  for (const name of existsSync(vendorDir) ? readdirSync(vendorDir).sort() : []) {
    const file = join(vendorDir, name, 'UPSTREAM.json');
    if (!existsSync(file)) continue;
    const u = readJson<Upstream>(file);
    out.push({ upstream: u, where: `copied (${u.level ?? 'L3'}) into src/vendor/${name}/ and built into dist/`, text: text(u.project) });
  }
  const manifest = readJson<{ otter?: { bundle?: string[] }; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(pkgDir, 'package.json'));
  for (const b of manifest.otter?.bundle ?? []) {
    if (b.startsWith('@otter-vendor/')) {
      const u = readJson<Upstream>(join(root, 'vendor', b.slice('@otter-vendor/'.length), 'UPSTREAM.json'));
      if (out.some((x) => x.upstream.project === u.project && x.upstream.commit === u.commit)) continue;
      out.push({ upstream: u, where: `vendored in the repository (vendor/${u.project}) and bundled into dist/`, text: text(u.project) });
    } else {
      const license = NPM_LICENSES[b];
      if (license === undefined) throw new Error(`${b} is bundled into ${pkgDir}: add its license to NPM_LICENSES and tooling/licenses/${b}.txt`);
      const version = manifest.devDependencies?.[b] ?? manifest.dependencies?.[b] ?? installedVersion(pkgDir, b, manifest.otter?.bundle ?? []);
      out.push({ upstream: { project: b, repo: `https://www.npmjs.com/package/${b}`, commit: version, license }, where: 'bundled from npm into dist/', text: text(b) });
    }
  }
  return out;
}

/** The NOTICE of a package, or undefined when it carries no third-party code. */
export function notice(name: string, pkgDir: string): string | undefined {
  const parts = thirdParty(pkgDir);
  if (parts.length === 0) return undefined;
  const list = parts.map(({ upstream: u, where }) => `- ${u.project} (${u.repo}, ${u.tag ?? u.commit}${u.tag === undefined ? '' : ` / ${u.commit}`}): ${u.license}; ${where}`);
  const texts = parts.map(({ upstream: u, text }) => `---------------------------------------------------------------------------\n${u.project}: ${u.license}\n---------------------------------------------------------------------------\n\n${text}`);
  return `${name}\nCopyright 2026 the Otter authors. Licensed under the Apache License 2.0 (LICENSE).\n\nThis package includes third-party code:\n\n${list.join('\n')}\n\nTheir licenses follow.\n\n${texts.join('\n\n')}\n`;
}

/** The files each published package must carry: path → content. */
export function releaseFiles(): Map<string, string> {
  const license = readFileSync(join(root, 'LICENSE'), 'utf8');
  const out = new Map<string, string>();
  const packages = join(root, 'packages');
  for (const dir of readdirSync(packages).sort()) {
    const pkgDir = join(packages, dir);
    if (!existsSync(join(pkgDir, 'package.json'))) continue;
    const manifest = readJson<{ name: string; private?: boolean }>(join(pkgDir, 'package.json'));
    if (manifest.private === true) continue;
    out.set(join('packages', dir, 'LICENSE'), license);
    const n = notice(manifest.name, pkgDir);
    if (n !== undefined) out.set(join('packages', dir, 'NOTICE'), n);
  }
  return out;
}

if (import.meta.filename === process.argv[1]) {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  for (const [rel, content] of releaseFiles()) {
    const file = join(root, rel);
    const now = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (now === content) continue;
    if (check) stale.push(rel);
    else writeFileSync(file, content);
  }
  // A NOTICE must be in `files` (npm packs LICENSE and README on its own, not NOTICE).
  for (const [rel] of releaseFiles()) {
    if (!rel.endsWith('NOTICE')) continue;
    const manifestFile = join(root, rel.replace(/NOTICE$/, 'package.json'));
    const manifest = readJson<{ files?: string[] }>(manifestFile);
    if ((manifest.files ?? []).includes('NOTICE')) continue;
    if (check) stale.push(`${rel.replace(/NOTICE$/, 'package.json')} ("files" lacks NOTICE)`);
    else writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, files: [...(manifest.files ?? []), 'NOTICE'] }, null, 2)}\n`);
  }
  if (stale.length > 0) {
    console.error(`✗ release files missing or stale (run \`node scripts/release-files.ts\`): ${stale.join(', ')}`);
    process.exit(1);
  }
  console.log(check ? `✓ release files: ${releaseFiles().size} up to date` : `✓ release files written (${releaseFiles().size})`);
}
