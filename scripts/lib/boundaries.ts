// Package boundary rules (AGENT §2, §4; SPEC §3). Pure function over package descriptors.

export interface PackageInfo {
  /** Directory name under packages/. */
  readonly dir: string;
  readonly manifest: {
    readonly name?: string;
    readonly type?: string;
    readonly license?: string;
    readonly sideEffects?: unknown;
    readonly exports?: unknown;
    readonly main?: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  /** compilerOptions.lib of the package tsconfig; undefined for CSS-only packages. */
  readonly lib: readonly string[] | undefined;
  /** Project references (directory names) of the package tsconfig. */
  readonly references: readonly string[];
  /** Import specifiers found in src/, per file. */
  readonly imports: Readonly<Record<string, readonly string[]>>;
}

const SCOPE = '@otter-player/';

/** Must compile without DOM types: core (SPEC §1.1) and the Worker-capable pipeline (SPEC §7). */
export const DOM_FREE = ['core', 'pipeline'] as const;

const ENGINE_IMPL = /^(backend-|format-|engine-adapter-|decoder-|pipeline$)/;
const RENDER = /^(surface|presentation|input|ui-core|ui-skin-.*|text|text-ass|danmaku|overlay-.*|react|vue|svelte)$/;
const SKIN = /^ui-skin-/;

/** Every string leaf of an `exports` map (file targets). */
const exportTargets = (exports: unknown): string[] => {
  if (typeof exports === 'string') return [exports];
  if (typeof exports !== 'object' || exports === null) return [];
  return Object.values(exports).flatMap(exportTargets);
};

const isBuiltin = (spec: string): boolean => spec.startsWith('node:');
const packageOf = (spec: string): string => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
};

export function checkBoundaries(packages: readonly PackageInfo[]): string[] {
  const problems: string[] = [];
  const report = (dir: string, message: string): void => {
    problems.push(`packages/${dir}: ${message}`);
  };

  for (const pkg of packages) {
    const { dir, manifest } = pkg;
    if (manifest.name !== `${SCOPE}${dir}`) report(dir, `name must be "${SCOPE}${dir}"`);
    if (manifest.type !== 'module') report(dir, 'must be ESM ("type": "module")');
    if (SKIN.test(dir)) {
      // Skins are CSS only (SPEC §14.4). `["*.css"]` keeps `import '@otter-player/ui-skin-*'` from
      // being tree-shaken away; the price is that a skin must never ship JS (ADR-002, Q7).
      if (JSON.stringify(manifest.sideEffects) !== '["*.css"]') report(dir, 'skin packages must declare "sideEffects": ["*.css"]');
      if (pkg.lib !== undefined) report(dir, 'skin packages are CSS only and must not have a tsconfig');
      for (const file of Object.keys(pkg.imports)) report(dir, `skin packages must not contain JS/TS (${file})`);
      for (const target of exportTargets(manifest.exports)) {
        if (!target.endsWith('.css')) report(dir, `skin packages may only export .css files, not ${target}`);
      }
    } else if (manifest.sideEffects !== false) {
      report(dir, '"sideEffects" must be false');
    }
    if (manifest.license !== 'Apache-2.0') report(dir, 'license must be Apache-2.0');
    if (manifest.exports === undefined) report(dir, '"exports" is required');
    if (manifest.main !== undefined) report(dir, '"main" is not allowed; use "exports"');

    const runtimeDeps = { ...manifest.dependencies, ...manifest.peerDependencies };
    const workspaceDeps = Object.keys(runtimeDeps)
      .filter((d) => d.startsWith(SCOPE))
      .map((d) => d.slice(SCOPE.length));

    // Core never depends on anything, and in particular never on an implementation (AGENT §2.2).
    if (dir === 'core' && Object.keys(runtimeDeps).length > 0) report(dir, 'core must have no runtime dependencies');
    if (dir === 'media') {
      for (const d of workspaceDeps) if (d !== 'core') report(dir, `media may only depend on core, not ${d}`);
    }
    // UI / Overlay / Presentation never reach into engine implementations (SPEC §3 rule 1).
    if (RENDER.test(dir)) {
      for (const d of workspaceDeps) {
        if (ENGINE_IMPL.test(d)) report(dir, `render-layer package must not depend on engine implementation ${d}`);
      }
    }
    // The engine knows nothing about rendering.
    if (ENGINE_IMPL.test(dir) || dir === 'media') {
      for (const d of workspaceDeps) if (RENDER.test(d)) report(dir, `engine package must not depend on ${d}`);
    }

    if ((DOM_FREE as readonly string[]).includes(dir)) {
      const domLibs = (pkg.lib ?? []).filter((l) => /^(dom|webworker)/i.test(l));
      if (pkg.lib === undefined || domLibs.length > 0) report(dir, 'tsconfig lib must not include DOM / WebWorker');
    }

    if (pkg.lib !== undefined) {
      const refs = [...pkg.references].sort();
      // L2 vendor packages (@otter-vendor/<p>, ADR-007 §1) are referenced as ../vendor/<p>.
      const vendorRefs = Object.keys(runtimeDeps)
        .filter((d) => d.startsWith('@otter-vendor/'))
        .map((d) => `../vendor/${d.slice('@otter-vendor/'.length)}`); // '../../vendor/x' minus the leading '../'
      const expected = [...workspaceDeps, ...vendorRefs].sort();
      if (refs.join() !== expected.join()) {
        report(dir, `tsconfig references [${refs.join(', ')}] must match workspace deps [${expected.join(', ')}]`);
      }
    }

    for (const [file, specs] of Object.entries(pkg.imports)) {
      for (const spec of specs) {
        if (spec.startsWith('.')) continue;
        if (dir === 'core') {
          report(dir, `${file} imports "${spec}"; core may only use relative imports`);
          continue;
        }
        if (isBuiltin(spec)) {
          report(dir, `${file} imports Node builtin "${spec}"`);
          continue;
        }
        if (!(packageOf(spec) in runtimeDeps)) report(dir, `${file} imports "${spec}" which is not a declared dependency`);
      }
    }
  }
  return problems;
}

/** Extracts static and dynamic import / re-export specifiers. Comments are stripped first. */
export function scanImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const specs = new Set<string>();
  const patterns = [
    /\bimport\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) if (m[1] !== undefined) specs.add(m[1]);
  return [...specs];
}

/**
 * Third-party APIs Otter must not call (REUSE §4): media-captions' renderers splice
 * entity-decoded cue text into HTML (unfixed XSS upstream); only its parser and tokenizer are used.
 */
export const BANNED_APIS: Readonly<Record<string, readonly string[]>> = {
  'media-captions': ['renderVTTCueString', 'renderVTTTokensString', 'createVTTCueTemplate', 'CaptionsRenderer', 'updateTimedVTTCueNodes'],
};

/** `module.api` uses of banned APIs in a file that imports that module. */
export function bannedApiUses(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const specs = scanImports(source);
  const hits: string[] = [];
  for (const [mod, apis] of Object.entries(BANNED_APIS)) {
    if (!specs.includes(mod)) continue;
    for (const api of apis) if (new RegExp(`\\b${api}\\b`).test(code)) hits.push(`${mod}.${api}`);
  }
  return hits;
}
