// Vendoring gate logic (REUSE §5, ADR-003 §7). Pure: the CLI collects the inputs.

export interface UpstreamFile {
  readonly upstream: string;
  readonly local: string;
}

export interface Upstream {
  readonly project: string;
  readonly repo: string;
  readonly commit: string;
  readonly license: string;
  readonly level: 'L2' | 'L3';
  readonly files: readonly UpstreamFile[];
  readonly localChanges: readonly string[];
  /**
   * L2 packages only: Otter's own files in the vendor dir (package.json, shims, entry, tests).
   * Globs: a trailing `/**` matches a directory. They must NOT carry a "Derived from" header.
   */
  readonly ownFiles?: readonly string[];
  /** Drift reviews (vendor-sync report evaluated): what was merged or why not. */
  readonly syncLog?: readonly { readonly date: string; readonly upstream: string; readonly decision: 'merged' | 'not-merged'; readonly reason: string }[];
}

export interface VendorDir {
  /** Repo-relative directory holding UPSTREAM.json. */
  readonly dir: string;
  /** Parsed UPSTREAM.json (unknown until validated). */
  readonly upstream: unknown;
  /** Files in the directory (relative to it), excluding UPSTREAM.json. */
  readonly files: readonly string[];
  /** Contents of every file in `files`. */
  readonly contents: Readonly<Record<string, string>>;
}

export interface RuntimeDependency {
  /** Workspace package that declares it. */
  readonly pkg: string;
  readonly name: string;
}

export interface VendorInput {
  readonly vendorDirs: readonly VendorDir[];
  readonly notices: string;
  readonly reuse: string;
  readonly runtimeDependencies: readonly RuntimeDependency[];
}

/** REUSE §2: only these licenses may be copied (L2 / L3); LGPL / GPL never. */
export const COPYABLE_LICENSES: readonly string[] = ['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause'];

/** Files that may live in a vendor directory without being listed. */
const UNLISTED_OK = new Set(['README.md']);

export const headerLine = (u: Pick<Upstream, 'project' | 'commit' | 'license'>, upstreamPath: string): string =>
  `// Derived from ${u.project}@${u.commit} ${upstreamPath}, ${u.license}`;

/** Leading comment block of a file: the header must sit before any code. */
function leadingComments(content: string): string[] {
  const lines: string[] = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('//') || line.trim() === '') lines.push(line.trim());
    else break;
  }
  return lines;
}

function validate(raw: unknown, dir: string, problems: string[]): Upstream | undefined {
  const report = (m: string): void => {
    problems.push(`${dir}/UPSTREAM.json: ${m}`);
  };
  if (typeof raw !== 'object' || raw === null) {
    report('not an object');
    return undefined;
  }
  const u = raw as Partial<Record<keyof Upstream, unknown>>;
  for (const key of ['project', 'repo', 'commit', 'license'] as const) {
    if (typeof u[key] !== 'string' || u[key] === '') report(`"${key}" must be a non-empty string`);
  }
  if (typeof u.commit === 'string' && !/^[0-9a-f]{40}$/.test(u.commit)) report('"commit" must be a full 40-character SHA');
  if (u.level !== 'L2' && u.level !== 'L3') report('"level" must be "L2" or "L3"');
  const files = Array.isArray(u.files) ? (u.files as unknown[]) : undefined;
  if (files === undefined || files.length === 0) report('"files" must list at least one { upstream, local }');
  const okFiles = (files ?? []).every(
    (f) => typeof f === 'object' && f !== null && typeof (f as UpstreamFile).upstream === 'string' && typeof (f as UpstreamFile).local === 'string',
  );
  if (!okFiles) report('every "files" entry needs string "upstream" and "local"');
  const changes = Array.isArray(u.localChanges) ? u.localChanges : undefined;
  if (changes === undefined || changes.length === 0) report('"localChanges" must describe what was changed');
  return problems.some((p) => p.startsWith(`${dir}/UPSTREAM.json`)) ? undefined : (raw as Upstream);
}

export function checkVendor(input: VendorInput): string[] {
  const problems: string[] = [];

  for (const vd of input.vendorDirs) {
    const u = validate(vd.upstream, vd.dir, problems);
    if (u === undefined) continue;

    if (!COPYABLE_LICENSES.includes(u.license)) {
      problems.push(`${vd.dir}: ${u.project} is ${u.license}; only ${COPYABLE_LICENSES.join(' / ')} may be copied (REUSE §2)`);
    }

    const listed = new Set(u.files.map((f) => f.local));
    const own = (file: string): boolean =>
      (u.ownFiles ?? []).some((g) => (g.endsWith('/**') ? file.startsWith(g.slice(0, -2)) : file === g));
    if (u.ownFiles !== undefined && u.level !== 'L2') problems.push(`${vd.dir}/UPSTREAM.json: "ownFiles" is only for L2 packages`);
    for (const file of vd.files) {
      if (listed.has(file) || UNLISTED_OK.has(file)) continue;
      if (own(file)) {
        // Own code must not pretend to be a copy (and copies must not hide among own files).
        if (/^\/\/ Derived from /m.test(vd.contents[file] ?? '')) problems.push(`${vd.dir}/${file}: listed as own file but carries a "Derived from" header`);
        continue;
      }
      problems.push(`${vd.dir}/${file}: not listed in UPSTREAM.json`);
    }
    for (const local of listed) {
      const content = vd.contents[local];
      if (content === undefined) {
        problems.push(`${vd.dir}/${local}: listed in UPSTREAM.json but missing`);
        continue;
      }
      if (local.endsWith('.json')) continue; // data files cannot carry comments
      const header = leadingComments(content);
      for (const f of u.files.filter((x) => x.local === local)) {
        const expected = headerLine(u, f.upstream);
        if (!header.includes(expected)) problems.push(`${vd.dir}/${local}: missing header "${expected}"`);
      }
    }

    if (!input.notices.includes(`### ${u.project} (${u.license})`)) {
      problems.push(`THIRD_PARTY_NOTICES.md: missing "### ${u.project} (${u.license})" for ${vd.dir}`);
    } else if (!input.notices.includes(u.commit)) {
      problems.push(`THIRD_PARTY_NOTICES.md: ${u.project} entry does not mention commit ${u.commit}`);
    }
    if (!input.notices.includes(vd.dir)) problems.push(`THIRD_PARTY_NOTICES.md: does not list ${vd.dir}`);
    if (!input.reuse.includes(u.project)) problems.push(`REUSE.md: ${u.project} is copied (${vd.dir}) but not listed`);
  }

  const seen = new Set<string>();
  for (const dep of input.runtimeDependencies) {
    if (seen.has(dep.name)) continue;
    seen.add(dep.name);
    if (!input.notices.includes(`| \`${dep.name}\` |`)) {
      problems.push(`THIRD_PARTY_NOTICES.md: runtime dependency ${dep.name} (${dep.pkg}) missing from the L1 table`);
    }
    if (!input.reuse.includes(dep.name)) problems.push(`REUSE.md: runtime dependency ${dep.name} (${dep.pkg}) is not listed`);
  }

  return problems;
}
