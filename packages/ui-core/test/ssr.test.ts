// @vitest-environment node
// On a server (no customElements): defining the elements is a no-op, not a ReferenceError
// (SSR, ADR-013 batch 3); with a registry given it still registers into it.
import { describe, expect, it } from 'vitest';
import { defineElements, defineOtterElements, M1_ELEMENTS, otterPlayButton } from '@otter-player/ui-core';

describe('defining the elements on a server', () => {
  it('does nothing without customElements, and returns no constructors', () => {
    expect(typeof customElements).toBe('undefined');
    expect(defineOtterElements()).toEqual({});
    expect(defineElements({ [M1_ELEMENTS.PlayButton]: otterPlayButton })).toEqual({});
  });
});
