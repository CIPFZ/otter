// Vendoring source-record checks (REUSE §5, ADR-008 §1): every copied file says where it came
// from, so vendor-sync can diff it against upstream. No license rules (ADR-008). Pure: the CLI
// collects the inputs.

export interface UpstreamFile {
  readonly upstream: string;
  readonly local: string;
  /**
   * Build artefacts copied byte for byte (WASM binaries, generated glue) cannot carry a header:
   * their SHA-256 at the pinned commit is recorded instead and checked.
   */
  readonly sha256?: string;
}

export interface Upstream {
  readonly project: string;
  readonly repo: string;
  readonly commit: string;
  /** Informational only (ADR-008): the project's license at the pinned commit. */
  readonly license?: string;
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
  /** SHA-256 (hex) of every file in `files`. */
  readonly hashes?: Readonly<Record<string, string>>;
}

export interface VendorInput {
  readonly vendorDirs: readonly VendorDir[];
  readonly reuse: string;
}

/** Files that may live in a vendor directory without being listed. */
const UNLISTED_OK = new Set(['README.md']);

/** The source header every copied file starts with; a trailing `, <license>` is allowed. */
export const headerLine = (u: Pick<Upstream, 'project' | 'commit'>, upstreamPath: string): string => `// Derived from ${u.project}@${u.commit} ${upstreamPath}`;

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
  for (const key of ['project', 'repo', 'commit'] as const) {
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
  const badHash = (files ?? []).some((f) => {
    const h = (f as UpstreamFile | null)?.sha256;
    return h !== undefined && !/^[0-9a-f]{64}$/.test(h);
  });
  if (badHash) report('"sha256" must be 64 lowercase hex characters');
  const changes = Array.isArray(u.localChanges) ? u.localChanges : undefined;
  if (changes === undefined || changes.length === 0) report('"localChanges" must describe what was changed');
  return problems.some((p) => p.startsWith(`${dir}/UPSTREAM.json`)) ? undefined : (raw as Upstream);
}

export function checkVendor(input: VendorInput): string[] {
  const problems: string[] = [];

  for (const vd of input.vendorDirs) {
    const u = validate(vd.upstream, vd.dir, problems);
    if (u === undefined) continue;

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
      const pinned = u.files.find((x) => x.local === local && x.sha256 !== undefined);
      if (pinned !== undefined) {
        if (vd.hashes?.[local] !== pinned.sha256) problems.push(`${vd.dir}/${local}: SHA-256 ${vd.hashes?.[local] ?? '?'} differs from the pinned ${pinned.sha256}`);
        continue;
      }
      const header = leadingComments(content);
      for (const f of u.files.filter((x) => x.local === local)) {
        const expected = headerLine(u, f.upstream);
        if (!header.some((line) => line === expected || line.startsWith(`${expected},`))) problems.push(`${vd.dir}/${local}: missing header "${expected}"`);
      }
    }

    if (!input.reuse.includes(u.project)) problems.push(`REUSE.md: ${u.project} is copied (${vd.dir}) but not listed`);
  }

  return problems;
}
