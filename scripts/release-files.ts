// LICENSE and NOTICE of every published package (ADR-014 §4). Each package ships the repository's
// Apache-2.0 LICENSE; a package that carries third-party code also ships a NOTICE listing it, with
// the upstream license texts:
// - copied code (L2 / L3): the package's `src/vendor/*/UPSTREAM.json` (project, repo, pinned commit,
//   license);
// - code bundled into its dist (`otter.bundle` in package.json): `@otter-vendor/*` from
//   `vendor/*/UPSTREAM.json`, npm packages by name.
// - MPL-2.0 dependencies of the production tree (installed from npm, files under MPL-2.0).
// The upstream texts live in tooling/licenses/<project>.txt (fetched once from the pinned commit,
// or copied from node_modules for npm packages). Placeholders (`private: true`) get neither.
// Before anything is written or checked, every published package must pass the license rules
// (scripts/lib/licenses.ts, ADR-014 §4a); `--audit` prints the per-package table of ADR-014.
//
//   node scripts/release-files.ts           write the files
//   node scripts/release-files.ts --check   fail when one is missing or stale (pnpm check)

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { audit, cdnInputs, classify, licenseProblems, type Item } from './lib/licenses.ts';

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

/** The license text of an npm package: tooling/licenses/<name>.txt, else its own LICENSE file. */
function npmLicenseText(name: string, dir: string): string {
  const kept = join(root, 'tooling/licenses', `${name.replace('/', '__')}.txt`);
  if (existsSync(kept)) return readFileSync(kept, 'utf8').trim();
  const own = readdirSync(dir).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  if (own === undefined) throw new Error(`${name}: no LICENSE file in ${dir}; add tooling/licenses/${name.replace('/', '__')}.txt`);
  return readFileSync(join(dir, own), 'utf8').trim();
}

/** The third-party code in a package, with where it sits. */
export function thirdParty(pkgDir: string): { upstream: Upstream; where: string; text: string }[] {
  const manifest0 = readJson<{ otter?: { cdn?: boolean } }>(join(pkgDir, 'package.json'));
  if (manifest0.otter?.cdn === true) {
    // A CDN build: the copied and bundled code of the workspace packages it took in, and every npm
    // package it took files from (bundled, so their notices travel with it).
    const inputs = cdnInputs(root, pkgDir);
    const seen = new Set<string>();
    const out: { upstream: Upstream; where: string; text: string }[] = [];
    for (const ws of inputs.workspace) {
      for (const p of thirdParty(join(root, 'packages', ws))) {
        if (p.where.startsWith('a dependency installed from npm')) continue;
        const key = `${p.upstream.project}@${p.upstream.commit}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...p, where: `in @otter-player/${ws} (${p.where}), built into dist/` });
      }
    }
    for (const n of inputs.npm) {
      const key = `${n.name}@${n.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // MPL-2.0 code built into a minified file stays MPL-2.0: say where its source form is.
      const repo = readJson<{ repository?: string | { url?: string } }>(join(n.dir, 'package.json')).repository;
      const source = (typeof repo === 'string' ? repo : repo?.url ?? `https://www.npmjs.com/package/${n.name}`).replace(/^git\+/, '').replace(/\.git$/, '');
      const where = classify(n.license) === 'mpl' ? `bundled from npm into dist/ (in on-demand chunks); these parts remain under ${n.license}, their source form is at ${source} (version ${n.version})` : 'bundled from npm into dist/';
      out.push({ upstream: { project: n.name, repo: `https://www.npmjs.com/package/${n.name}`, commit: n.version, license: n.license }, where, text: npmLicenseText(n.name, n.dir) });
    }
    return out;
  }
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
  // MPL-2.0 dependencies (ADR-014 §4a): installed from npm, not copied; listed, their files keep MPL-2.0.
  for (const dep of audit(root, pkgDir).filter((i) => i.kind === 'dependency' && i.verdict === 'mpl')) {
    const [project, version] = [dep.name.slice(0, dep.name.lastIndexOf('@')), dep.name.slice(dep.name.lastIndexOf('@') + 1)];
    out.push({ upstream: { project, repo: `https://www.npmjs.com/package/${project}`, commit: version, license: dep.license }, where: `a dependency installed from npm (${dep.via ?? project}), unmodified; its files stay under ${dep.license}`, text: text(project) });
  }
  return out;
}

/** The license audit of every published package (ADR-014 §4a): items and problems. */
export function licenseAudit(): { pkg: string; items: Item[]; problems: string[] }[] {
  const packages = join(root, 'packages');
  return readdirSync(packages)
    .sort()
    .filter((dir) => existsSync(join(packages, dir, 'package.json')))
    .map((dir) => ({ dir, m: readJson<{ name: string; private?: boolean }>(join(packages, dir, 'package.json')) }))
    .filter(({ m }) => m.private !== true)
    .map(({ dir, m }) => {
      const items = audit(root, join(packages, dir));
      return { pkg: m.name, items, problems: licenseProblems(m.name, items) };
    });
}

/** The audit as a Markdown table: per package, what it carries and pulls in, by license. */
export function auditTable(): string {
  const cell = (items: Item[], kind: Item['kind']): string => {
    const by = new Map<string, Set<string>>();
    for (const i of items.filter((x) => x.kind === kind)) {
      // A copied file: its project (the directory under vendor/); a package: name@version.
      const vendored = /(?:^|\/)vendor\/([^/]+)\//.exec(i.name)?.[1];
      const who = vendored ?? i.name;
      by.set(i.license, (by.get(i.license) ?? new Set()).add(who));
    }
    return by.size === 0 ? '—' : [...by].map(([l, w]) => `${l}: ${[...w].join(', ')}`).join('; ');
  };
  const rows = licenseAudit().map(({ pkg, items, problems }) => `| \`${pkg.replace('@otter-player/', '')}\` | ${cell(items, 'copied')} | ${cell(items, 'bundled')} | ${cell(items, 'dependency')} | ${problems.length === 0 ? (items.some((i) => classify(i.license) === 'mpl') ? 'OK (MPL-2.0 in NOTICE)' : 'OK') : `✗ ${problems.length}`} |`);
  return ['| 包 | 拷入代码（src/vendor） | 打包进 dist | 生产依赖树（第三方） | 结论 |', '|---|---|---|---|---|', ...rows].join('\n');
}

/** The NOTICE of a package, or undefined when it carries no third-party code. */
export function notice(name: string, pkgDir: string): string | undefined {
  const parts = thirdParty(pkgDir);
  if (parts.length === 0) return undefined;
  const list = parts.map(({ upstream: u, where }) => `- ${u.project} (${u.repo}, ${u.tag ?? u.commit}${u.tag === undefined ? '' : ` / ${u.commit}`}): ${u.license}; ${where}`);
  const texts = parts.map(({ upstream: u, text }) => `---------------------------------------------------------------------------\n${u.project}: ${u.license}\n---------------------------------------------------------------------------\n\n${text}`);
  return `${name}\nCopyright 2026 the Otter authors. Licensed under the Apache License 2.0 (LICENSE).\n\nThis package includes or depends on third-party code:\n\n${list.join('\n')}\n\nTheir licenses follow.\n\n${texts.join('\n\n')}\n`;
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

/** Compares release text while tolerating Git's CRLF checkout conversion. */
export function releaseFileMatches(actual: string | undefined, expected: string): boolean {
  return actual !== undefined && actual.replace(/\r\n/g, '\n') === expected.replace(/\r\n/g, '\n');
}

if (import.meta.filename === process.argv[1]) {
  if (process.argv.includes('--audit')) {
    console.log(auditTable());
    process.exit(0);
  }
  const check = process.argv.includes('--check');
  const refused = licenseAudit().flatMap((a) => a.problems);
  if (refused.length > 0) {
    for (const p of refused) console.error(`✗ ${p}`);
    console.error(`✗ ${refused.length} license problem(s) in published packages (ADR-014 §4a): make the package private, or drop the code`);
    process.exit(1);
  }
  const stale: string[] = [];
  for (const [rel, content] of releaseFiles()) {
    const file = join(root, rel);
    const now = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (releaseFileMatches(now, content)) continue;
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
  // A placeholder carries neither (it is not published; a leftover would suggest it is).
  for (const dir of readdirSync(join(root, 'packages'))) {
    const manifestFile = join(root, 'packages', dir, 'package.json');
    if (!existsSync(manifestFile) || readJson<{ private?: boolean }>(manifestFile).private !== true) continue;
    for (const f of ['LICENSE', 'NOTICE']) {
      const file = join(root, 'packages', dir, f);
      if (!existsSync(file)) continue;
      if (check) stale.push(`packages/${dir}/${f} (a private package)`);
      else rmSync(file);
    }
  }
  if (stale.length > 0) {
    console.error(`✗ release files missing or stale (run \`node scripts/release-files.ts\`): ${stale.join(', ')}`);
    process.exit(1);
  }
  console.log(check ? `✓ release files: ${releaseFiles().size} up to date` : `✓ release files written (${releaseFiles().size})`);
}
