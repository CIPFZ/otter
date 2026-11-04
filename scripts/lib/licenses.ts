// The license rules of published packages (ADR-014 §4a, 2026-11-04; they replace ADR-008 §1's
// "not distributed, no obligations" premise). A public package may carry only:
// - MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, 0BSD;
// - MPL-2.0, its files under their own license, listed in the package's NOTICE;
// - LGPL only as separately loaded artefacts that are not in the tarball (so: never in a public
//   package's files); GPL / AGPL never.
// Inputs: the license names of the source headers (`// Derived from <project>@<commit> <path>
// <license>`) and of UPSTREAM.json for copied code, the license field of every third-party package
// in the production dependency tree, and of npm packages bundled into dist.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const PERMISSIVE: ReadonlySet<string> = new Set(['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC', '0BSD']);
/** Allowed with a NOTICE entry; files keep their license. */
export const WEAK_COPYLEFT: ReadonlySet<string> = new Set(['MPL-2.0']);

export type Verdict = 'permissive' | 'mpl' | 'lgpl' | 'gpl' | 'unknown';

/** The verdict of a license name or SPDX expression (`(MIT OR Apache-2.0)`, `GPL-3.0 (repository LICENSE)`). */
export function classify(license: string | undefined): Verdict {
  if (license === undefined || license.trim() === '') return 'unknown';
  const expr = license.replace(/\s*\([^()]*\b(repository|see|file)\b[^()]*\)\s*$/i, '').trim().replace(/^\((.*)\)$/, '$1');
  const one = (id: string): Verdict => {
    const t = id.trim().replace(/^\((.*)\)$/, '$1').replace(/\+$/, '');
    if (PERMISSIVE.has(t)) return 'permissive';
    if (WEAK_COPYLEFT.has(t)) return 'mpl';
    if (/^LGPL/i.test(t)) return 'lgpl';
    if (/^A?GPL/i.test(t)) return 'gpl';
    return 'unknown';
  };
  const rank: Record<Verdict, number> = { permissive: 0, mpl: 1, lgpl: 2, gpl: 3, unknown: 4 };
  if (/\bOR\b/.test(expr)) {
    // The best alternative applies.
    return expr.split(/\bOR\b/).map((p) => classify(p)).reduce((a, b) => (rank[a] <= rank[b] ? a : b));
  }
  if (/\bAND\b/.test(expr)) return expr.split(/\bAND\b/).map((p) => classify(p)).reduce((a, b) => (rank[a] >= rank[b] ? a : b));
  return one(expr);
}

/** Why a verdict keeps something out of a public package, or undefined when it may go in. */
export function refusal(v: Verdict): string | undefined {
  if (v === 'lgpl') return 'LGPL only as a separately loaded artefact outside the tarball';
  if (v === 'gpl') return 'GPL / AGPL may not be in a public package';
  if (v === 'unknown') return 'no recognised license';
  return undefined;
}

export interface Item {
  /** What it is: a copied file, a bundled package, a dependency. */
  readonly kind: 'copied' | 'bundled' | 'dependency';
  readonly name: string;
  readonly license: string;
  readonly verdict: Verdict;
  /** For a dependency: the chain from the package (`mediabunny`, `a > b`). */
  readonly via?: string;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const walk = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])) : []);

/** The license of a copied file: its header's name, else its directory's UPSTREAM.json. */
function copiedFiles(vendorRoot: string, root: string): Item[] {
  const out: Item[] = [];
  for (const project of existsSync(vendorRoot) ? readdirSync(vendorRoot).sort() : []) {
    const dir = join(vendorRoot, project);
    const manifest = join(dir, 'UPSTREAM.json');
    const upstream = existsSync(manifest) ? readJson<{ license?: string }>(manifest) : {};
    for (const file of walk(dir)) {
      if (file === manifest) continue;
      const head = /\.(ts|js|mjs|css)$/.test(file) ? readFileSync(file, 'utf8').slice(0, 2000) : '';
      const header = /Derived from \S+@[0-9a-f]+ \S+ ([A-Za-z0-9.+-]+(?: (?:OR|AND) [A-Za-z0-9.+-]+)*)\s*$/m.exec(head)?.[1];
      const license = header ?? upstream.license ?? '';
      out.push({ kind: 'copied', name: relative(root, file), license, verdict: classify(license) });
    }
  }
  return out;
}

/** `<dir>/node_modules/<name>/package.json` from `fromDir` upwards (Node's lookup, without `exports`). */
function findPackage(fromDir: string, name: string): string | undefined {
  for (let d = fromDir; ; d = dirname(d)) {
    const file = join(d, 'node_modules', name, 'package.json');
    // The real path: pnpm links packages in, their own dependencies sit next to the real one.
    if (existsSync(file)) return realpathSync(file);
    if (dirname(d) === d) return undefined;
  }
}

/** Third-party packages reachable from `pkgDir` through production dependencies (workspace packages excluded). */
function dependencyTree(pkgDir: string, names: readonly string[]): Item[] {
  const out = new Map<string, Item>();
  const visit = (fromDir: string, deps: readonly string[], chain: string): void => {
    for (const dep of deps) {
      if (dep.startsWith('@otter-player/') || dep.startsWith('@otter-vendor/')) continue;
      const file = findPackage(fromDir, dep);
      if (file === undefined) {
        out.set(dep, { kind: 'dependency', name: dep, license: '', verdict: 'unknown', via: chain === '' ? dep : `${chain} > ${dep}` });
        continue;
      }
      const m = readJson<{ name: string; version: string; license?: string | { type?: string }; dependencies?: Record<string, string> }>(file);
      const key = `${m.name}@${m.version}`;
      if (out.has(key)) continue;
      const license = typeof m.license === 'string' ? m.license : (m.license?.type ?? '');
      const via = chain === '' ? m.name : `${chain} > ${m.name}`;
      out.set(key, { kind: 'dependency', name: key, license, verdict: classify(license), via });
      visit(dirname(file), Object.keys(m.dependencies ?? {}), via);
    }
  };
  visit(pkgDir, names, '');
  return [...out.values()];
}

/** Everything third-party a package's tarball carries or pulls in, with its license. */
export function audit(root: string, pkgDir: string): Item[] {
  const manifest = readJson<{ dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; devDependencies?: Record<string, string>; otter?: { bundle?: string[] } }>(join(pkgDir, 'package.json'));
  const items = copiedFiles(join(pkgDir, 'src/vendor'), root);
  for (const b of manifest.otter?.bundle ?? []) {
    if (b.startsWith('@otter-vendor/')) {
      items.push(...copiedFiles(join(root, 'vendor'), root).filter((i) => i.name.startsWith(join('vendor', b.slice('@otter-vendor/'.length)))).map((i) => ({ ...i, kind: 'bundled' as const })));
    } else {
      const tree = dependencyTree(pkgDir, [b]);
      // The bundled package itself, and whatever of its tree is bundled with it (sax under imsc).
      items.push(...tree.filter((t) => (manifest.otter?.bundle ?? []).some((x) => t.name.startsWith(`${x}@`))).map((t) => ({ ...t, kind: 'bundled' as const })));
    }
  }
  items.push(...dependencyTree(pkgDir, [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]));
  return items;
}

/** The problems of a public package under the rules (empty: it may be published). */
export function licenseProblems(name: string, items: readonly Item[]): string[] {
  return items.flatMap((i) => {
    const why = refusal(i.verdict);
    return why === undefined ? [] : [`${name}: ${i.kind} ${i.via ?? i.name} is ${i.license === '' ? 'without a license' : i.license}: ${why}`];
  });
}
