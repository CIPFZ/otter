// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { defineElements, M1_ELEMENTS, otterPlayButton } from '@otter-player/ui-core';

describe('defineElements', () => {
  it('registers only the requested elements, once, and returns the same class every time', () => {
    // A registry stand-in: only get / define are used.
    const map = new Map<string, CustomElementConstructor>();
    const registry = { get: (t: string) => map.get(t), define: (t: string, c: CustomElementConstructor) => void map.set(t, c) } as unknown as CustomElementRegistry;
    const first = defineElements({ [M1_ELEMENTS.PlayButton]: otterPlayButton }, { registry });
    const again = defineElements({ [M1_ELEMENTS.PlayButton]: otterPlayButton }, { registry });
    expect(registry.get(M1_ELEMENTS.PlayButton)).toBe(first[M1_ELEMENTS.PlayButton]);
    expect(again[M1_ELEMENTS.PlayButton]).toBe(first[M1_ELEMENTS.PlayButton]);
    expect(registry.get(M1_ELEMENTS.MuteButton)).toBeUndefined();
    expect(otterPlayButton()).toBe(first[M1_ELEMENTS.PlayButton]);
  });
});
