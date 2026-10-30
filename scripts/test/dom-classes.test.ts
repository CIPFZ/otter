import { describe, expect, it } from 'vitest';
import { topLevelBrowserClasses } from '../lib/dom-classes.ts';

describe('topLevelBrowserClasses', () => {
  it('flags top-level classes extending browser-only globals, in every declaration form', () => {
    expect(topLevelBrowserClasses('class A extends HTMLElement {}\nexport class B extends AudioWorkletNode {}\nvar C = class extends HTMLButtonElement {};')).toEqual(['HTMLElement', 'AudioWorkletNode', 'HTMLButtonElement']);
  });

  it('leaves classes built inside functions, server globals, and bases the module declares or imports', () => {
    const code = [
      'function make() {',
      '\tclass Lazy extends HTMLElement {}',
      '\treturn Lazy;',
      '}',
      'class E extends EventTarget {}',
      'class Base {}',
      'class D extends Base {}',
      "import { Thing } from './thing.js';",
      'class F extends Thing {}',
      'var WORKLET = `',
      'class Processor extends AudioWorkletProcessor {}',
      '`;',
    ].join('\n');
    expect(topLevelBrowserClasses(code)).toEqual([]);
  });
});
