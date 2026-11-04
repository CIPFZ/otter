// The public API surface, read from the sources with the TypeScript checker (M5 handoff §7,
// ADR-013 batch 4: the docs site is generated, not written by hand). For every package entry in
// `exports` (the `@otter-player/source` condition): each exported name with its kind, signature
// and doc comment; for interfaces, their members. CSS-only skins: the `--otter-*` variables they set.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'ts5';

/** A TSDoc block tag: `@defaultValue`, `@example`, `@see`, `@param`, ... */
export interface ApiTag {
  readonly name: string;
  readonly text: string;
}

export interface ApiMember {
  readonly name: string;
  readonly type: string;
  readonly doc: string;
  readonly tags: readonly ApiTag[];
  /** `{@link X}` targets in the comment. */
  readonly links: readonly string[];
  readonly optional: boolean;
}

export interface ApiExport {
  readonly name: string;
  readonly kind: 'function' | 'const' | 'class' | 'interface' | 'type' | 'enum';
  /** Call signatures (functions), the type (consts, aliases), or empty (interfaces: see members). */
  readonly signature: string;
  readonly doc: string;
  readonly tags: readonly ApiTag[];
  /** `{@link X}` targets in the comment. */
  readonly links: readonly string[];
  readonly members: readonly ApiMember[];
}

export interface ApiEntry {
  /** `@otter-player/presets/vod`. */
  readonly specifier: string;
  readonly pkg: string;
  readonly file: string;
  readonly css: boolean;
  readonly exports: readonly ApiExport[];
  /** CSS entries: the custom properties they declare, with their first value. */
  readonly variables: readonly { readonly name: string; readonly value: string }[];
}

export interface ApiSurface {
  readonly entries: readonly ApiEntry[];
  /** Exported names without a doc comment (TSDoc coverage, report only). */
  readonly undocumented: readonly string[];
}

const MAX_TYPE = 400;
const clip = (s: string): string => (s.length > MAX_TYPE ? `${s.slice(0, MAX_TYPE)} …` : s);

/** Every entry of every package: source files of JS entries, dist CSS of skins. */
export function listEntries(root: string): { specifier: string; pkg: string; file: string; css: boolean }[] {
  const out: { specifier: string; pkg: string; file: string; css: boolean }[] = [];
  const packages = join(root, 'packages');
  for (const dir of readdirSync(packages).sort()) {
    const manifestPath = join(packages, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string; exports?: Record<string, string | Record<string, string>> };
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      const specifier = key === '.' ? manifest.name : `${manifest.name}/${key.replace(/^\.\//, '')}`;
      const conditions = typeof value === 'string' ? { default: value } : value;
      const source = conditions['@otter-player/source'];
      if (source !== undefined) {
        out.push({ specifier, pkg: manifest.name, file: join(packages, dir, source), css: false });
        continue;
      }
      // CSS skins (dist) and source-shipped components (.svelte): the CSS ones are documented.
      const target = conditions['style'] ?? conditions['default'];
      if (target?.endsWith('.css') === true) out.push({ specifier, pkg: manifest.name, file: join(packages, dir, target.replace(/^\.\/dist\//, './src/')), css: true });
    }
  }
  return out;
}

const kindOf = (decl: ts.Declaration): ApiExport['kind'] | undefined => {
  if (ts.isFunctionDeclaration(decl)) return 'function';
  if (ts.isVariableDeclaration(decl)) return 'const';
  if (ts.isClassDeclaration(decl)) return 'class';
  if (ts.isInterfaceDeclaration(decl)) return 'interface';
  if (ts.isTypeAliasDeclaration(decl)) return 'type';
  if (ts.isEnumDeclaration(decl)) return 'enum';
  return undefined;
};

const tagsOf = (symbol: ts.Symbol, checker: ts.TypeChecker): ApiTag[] =>
  symbol.getJsDocTags(checker).map((t) => ({ name: t.name, text: ts.displayPartsToString(t.text).trim() }));

/** The `{@link X}` / `{@link X.y}` targets of a symbol's comment and tags (the name before any `.`, `#` or `|`). */
const linksOf = (symbol: ts.Symbol, checker: ts.TypeChecker): string[] => {
  const parts = [...symbol.getDocumentationComment(checker), ...symbol.getJsDocTags(checker).flatMap((t) => t.text ?? [])];
  return parts.filter((p) => p.kind === 'linkName').map((p) => p.text.trim());
};

/** The API surface of the repository at `root`. */
export function readApiSurface(root: string): ApiSurface {
  const entries = listEntries(root);
  const tsEntries = entries.filter((e) => !e.css);
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile).config as object;
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram({ rootNames: tsEntries.map((e) => e.file), options: { ...parsed.options, noEmit: true } });
  const checker = program.getTypeChecker();
  const fmt = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
  const undocumented: string[] = [];
  const out: ApiEntry[] = [];
  for (const e of entries) {
    if (e.css) {
      const css = existsSync(e.file) ? readFileSync(e.file, 'utf8') : '';
      const seen = new Map<string, string>();
      for (const m of css.matchAll(/(--otter-[\w-]+)\s*:\s*([^;]+);/g)) if (!seen.has(m[1] as string)) seen.set(m[1] as string, (m[2] as string).trim());
      out.push({ ...e, file: relative(root, e.file), exports: [], variables: [...seen].map(([name, value]) => ({ name, value: clip(value) })) });
      continue;
    }
    const sf = program.getSourceFile(e.file);
    const moduleSymbol = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
    const exports: ApiExport[] = [];
    for (const raw of moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)) {
      const symbol = raw.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(raw) : raw;
      const decl = symbol.declarations?.[0];
      if (decl === undefined) continue;
      const kind = kindOf(decl);
      if (kind === undefined) continue;
      const doc = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
      let signature = '';
      let members: ApiMember[] = [];
      if (kind === 'function') {
        const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
        signature = type.getCallSignatures().map((s) => clip(`${raw.name}${checker.signatureToString(s, undefined, fmt)}`)).join('\n');
      } else if (kind === 'const') {
        signature = clip(checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, decl), undefined, fmt));
      } else if (kind === 'type') {
        signature = clip(checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol), undefined, fmt | ts.TypeFormatFlags.InTypeAlias));
      }
      if (kind === 'interface' || kind === 'class') {
        const type = checker.getDeclaredTypeOfSymbol(symbol);
        members = checker.getPropertiesOfType(type).map((p) => {
          const pd = p.valueDeclaration ?? p.declarations?.[0];
          return {
            name: p.name,
            type: clip(pd === undefined ? '' : checker.typeToString(checker.getTypeOfSymbolAtLocation(p, pd), undefined, fmt)),
            doc: ts.displayPartsToString(p.getDocumentationComment(checker)).trim(),
            tags: tagsOf(p, checker),
            links: linksOf(p, checker),
            optional: (p.flags & ts.SymbolFlags.Optional) !== 0,
          };
        });
      }
      if (doc === '') undocumented.push(`${e.specifier}#${raw.name}`);
      exports.push({ name: raw.name, kind, signature, doc, tags: tagsOf(symbol, checker), links: linksOf(symbol, checker), members });
    }
    exports.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ ...e, file: relative(root, e.file), exports, variables: [] });
  }
  return { entries: out, undocumented };
}
