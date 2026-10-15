// License gate logic (REUSE §2, §5). Pure functions over a dependency forest so they can be unit
// tested without touching node_modules.

export type LicenseClass = 'permissive' | 'tooling' | 'lgpl' | 'gpl' | 'unknown';

export type DependencyScope = 'prod' | 'dev';

export interface LicensePolicy {
  /** Allowed anywhere, including shipped runtime dependencies. */
  readonly permissive: readonly string[];
  /** Allowed only for development tooling that never ships (devDependencies trees). */
  readonly tooling: readonly string[];
  /** Workspace packages that may ship LGPL runtime dependencies as separate modules. */
  readonly lgplOwners: readonly RegExp[];
  /** Explicit decisions for packages with missing or non-SPDX license metadata. */
  readonly overrides: Readonly<Record<string, { readonly license: string; readonly reason: string }>>;
}

export interface DependencyNode {
  readonly name: string;
  readonly version: string;
  /** Raw `license` metadata; undefined when the package declares none. */
  readonly license: string | undefined;
  /** True for workspace packages (linked from this repo). */
  readonly workspace: boolean;
  /** False when the package is not installed on this platform (optional dependencies). */
  readonly installed: boolean;
  readonly dependencies: readonly DependencyNode[];
}

export interface ProjectTree {
  readonly name: string;
  readonly license: string | undefined;
  readonly prod: readonly DependencyNode[];
  readonly dev: readonly DependencyNode[];
}

export interface Violation {
  readonly package: string;
  readonly license: string;
  readonly scope: DependencyScope;
  /** Nearest workspace package that pulls the dependency in. */
  readonly owner: string;
  readonly chain: readonly string[];
  readonly reason: string;
}

export interface GateReport {
  readonly violations: readonly Violation[];
  /** Distinct `name@version` per license expression, for the summary. */
  readonly licenses: Readonly<Record<string, number>>;
  readonly scanned: number;
  readonly notInstalled: readonly string[];
}

// SPDX expression -----------------------------------------------------------------------------

export type SpdxNode =
  | { readonly kind: 'license'; readonly id: string; readonly exception?: string }
  | { readonly kind: 'and' | 'or'; readonly left: SpdxNode; readonly right: SpdxNode };

/** Parses `MIT`, `(MIT OR Apache-2.0)`, `Apache-2.0 WITH LLVM-exception AND BSD-3-Clause`. */
export function parseSpdx(expression: string): SpdxNode {
  const tokens = expression.replace(/[()]/g, ' $& ').trim().split(/\s+/).filter((t) => t !== '');
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string => {
    const t = tokens[pos++];
    if (t === undefined) throw new SyntaxError(`unexpected end of SPDX expression "${expression}"`);
    return t;
  };
  const isOp = (t: string | undefined, op: string): boolean => t !== undefined && t.toUpperCase() === op;

  const primary = (): SpdxNode => {
    const t = next();
    if (t === '(') {
      const inner = or();
      if (next() !== ')') throw new SyntaxError(`missing ")" in SPDX expression "${expression}"`);
      return inner;
    }
    if (t === ')' || isOp(t, 'AND') || isOp(t, 'OR') || isOp(t, 'WITH')) {
      throw new SyntaxError(`unexpected "${t}" in SPDX expression "${expression}"`);
    }
    if (isOp(peek(), 'WITH')) {
      pos++;
      return { kind: 'license', id: t, exception: next() };
    }
    return { kind: 'license', id: t };
  };
  const and = (): SpdxNode => {
    let left = primary();
    while (isOp(peek(), 'AND')) {
      pos++;
      left = { kind: 'and', left, right: primary() };
    }
    return left;
  };
  const or = (): SpdxNode => {
    let left = and();
    while (isOp(peek(), 'OR')) {
      pos++;
      left = { kind: 'or', left, right: and() };
    }
    return left;
  };

  const result = or();
  if (pos !== tokens.length) throw new SyntaxError(`trailing tokens in SPDX expression "${expression}"`);
  return result;
}

export function classifyLicenseId(id: string, policy: LicensePolicy): LicenseClass {
  const base = id.replace(/\+$/, '');
  // Order matters: LGPL before GPL, since "LGPL-2.1" also ends with "GPL-2.1".
  if (/^LGPL-/i.test(base)) return 'lgpl';
  if (/^(A|)GPL-|^SSPL-|^EUPL-|^OSL-|^CPAL-/i.test(base)) return 'gpl';
  if (policy.permissive.includes(base)) return 'permissive';
  if (policy.tooling.includes(base)) return 'tooling';
  return 'unknown';
}

interface Context {
  readonly scope: DependencyScope;
  readonly lgplAllowed: boolean;
}

function allowed(cls: LicenseClass, ctx: Context): boolean {
  switch (cls) {
    case 'permissive':
      return true;
    case 'tooling':
      return ctx.scope === 'dev';
    case 'lgpl':
      return ctx.scope === 'prod' && ctx.lgplAllowed;
    case 'gpl':
    case 'unknown':
      return false;
  }
}

function evaluate(node: SpdxNode, policy: LicensePolicy, ctx: Context): boolean {
  switch (node.kind) {
    case 'license':
      return allowed(classifyLicenseId(node.id, policy), ctx);
    case 'and':
      return evaluate(node.left, policy, ctx) && evaluate(node.right, policy, ctx);
    case 'or':
      return evaluate(node.left, policy, ctx) || evaluate(node.right, policy, ctx);
  }
}

function explain(license: string, policy: LicensePolicy, ctx: Context): string {
  let ids: string[];
  try {
    ids = collectIds(parseSpdx(license));
  } catch {
    return `"${license}" is not a valid SPDX expression; add an override in scripts/license-policy.ts`;
  }
  const classes = ids.map((id) => classifyLicenseId(id, policy));
  if (classes.includes('gpl')) return 'GPL-family licenses are forbidden anywhere in the dependency tree';
  if (classes.includes('lgpl')) {
    return ctx.scope === 'dev'
      ? 'LGPL is not allowed in development dependencies'
      : 'LGPL is only allowed in decoder-* and text-ass, loaded as a separate module';
  }
  if (classes.includes('tooling')) return `${license} is only allowed for development tooling, not shipped code`;
  return `${license} is not in the allow list; record it in REUSE.md §2 and scripts/license-policy.ts first`;
}

function collectIds(node: SpdxNode): string[] {
  return node.kind === 'license' ? [node.id] : [...collectIds(node.left), ...collectIds(node.right)];
}

/** Checks a single license string in a given context. */
export function checkLicense(
  license: string,
  policy: LicensePolicy,
  ctx: Context,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  let ok: boolean;
  try {
    ok = evaluate(parseSpdx(license), policy, ctx);
  } catch {
    ok = false;
  }
  return ok ? { ok: true } : { ok: false, reason: explain(license, policy, ctx) };
}

// Forest walk ---------------------------------------------------------------------------------

export function runGate(projects: readonly ProjectTree[], policy: LicensePolicy): GateReport {
  const violations = new Map<string, Violation>();
  const licenses = new Map<string, Set<string>>();
  const notInstalled = new Set<string>();
  const scanned = new Set<string>();

  const resolveLicense = (node: DependencyNode): string => {
    const override = policy.overrides[`${node.name}@${node.version}`] ?? policy.overrides[node.name];
    return override?.license ?? node.license ?? 'UNKNOWN';
  };

  const record = (v: Violation): void => {
    const key = `${v.package}|${v.scope}|${v.owner}`;
    if (!violations.has(key)) violations.set(key, v);
  };

  const visit = (
    node: DependencyNode,
    scope: DependencyScope,
    owner: string,
    chain: readonly string[],
    onPath: ReadonlySet<string>,
  ): void => {
    const id = `${node.name}@${node.version}`;
    if (onPath.has(id)) return;
    const here = [...chain, id];
    if (!node.installed) {
      notInstalled.add(id);
      return;
    }
    const nextOwner = node.workspace ? node.name : owner;
    if (!node.workspace) {
      scanned.add(id);
      const license = resolveLicense(node);
      let set = licenses.get(license);
      if (set === undefined) {
        set = new Set();
        licenses.set(license, set);
      }
      set.add(id);
      const lgplAllowed = policy.lgplOwners.some((re) => re.test(owner));
      const result = checkLicense(license, policy, { scope, lgplAllowed });
      if (!result.ok) record({ package: id, license, scope, owner, chain: here, reason: result.reason });
    }
    const nextPath = new Set(onPath).add(id);
    for (const dep of node.dependencies) visit(dep, scope, nextOwner, here, nextPath);
  };

  for (const project of projects) {
    const own = project.license ?? 'UNKNOWN';
    if (own !== 'Apache-2.0') {
      record({
        package: project.name,
        license: own,
        scope: 'prod',
        owner: project.name,
        chain: [project.name],
        reason: 'workspace packages must be Apache-2.0 (root LICENSE)',
      });
    }
    const root = new Set([project.name]);
    for (const dep of project.prod) visit(dep, 'prod', project.name, [project.name], root);
    for (const dep of project.dev) visit(dep, 'dev', project.name, [project.name], root);
  }

  return {
    violations: [...violations.values()],
    licenses: Object.fromEntries([...licenses].map(([license, ids]) => [license, ids.size])),
    scanned: scanned.size,
    notInstalled: [...notInstalled],
  };
}
