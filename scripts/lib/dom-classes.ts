// Top-level classes that extend a browser-only global (`class X extends HTMLElement`): evaluated at
// import, they throw a ReferenceError on a server (SSR), yet esbuild drops them when unused as if
// they had no side effects, so the tree-shaking gate cannot see them (ADR-013 batch 3).

/** `class [Name] extends <Ident>` with no indentation: module top level in the built (unminified) output. */
const TOP_LEVEL_EXTENDS = /^(?:export\s+)?(?:(?:var|let|const)\s+[\w$]+\s*=\s*)?class(?:\s+[\w$]+)?\s+extends\s+([A-Za-z_$][\w$]*)\b/gm;

/**
 * The browser-only base classes extended at the top level of `code`: identifiers the module does not
 * declare or import itself and that `serverGlobals` (by default this Node's globals) lack.
 */
const inThisRuntime = (name: string): boolean => Object.prototype.hasOwnProperty.call(globalThis, name) || name in globalThis;

export function topLevelBrowserClasses(code: string, serverGlobals: (name: string) => boolean = inThisRuntime): string[] {
  const out: string[] = [];
  // Source text in template literals (an AudioWorklet's module, a Worker's) is not module code.
  code = code.replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``');
  for (const m of code.matchAll(TOP_LEVEL_EXTENDS)) {
    const base = m[1] as string;
    const declared = new RegExp(`(?:^|[\\s,{;(])(?:class|function|var|let|const|import)\\s+(?:[^;]*?[\\s,{])?${base.replace(/\$/g, '\\$')}\\b`, 'm').test(code.replace(m[0], ''));
    if (!declared && !serverGlobals(base)) out.push(base);
  }
  return out;
}
