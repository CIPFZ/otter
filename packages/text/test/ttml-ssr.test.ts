// @vitest-environment node
// TTML on a server: a clear error instead of imscJS's ReferenceError (SSR, ADR-013 batch 3).
import { describe, expect, it } from 'vitest';
import { parseTtml } from '../src/ttml.js';

describe('TTML on a server', () => {
  it('rejects with a message saying it runs in a browser', async () => {
    expect(typeof window).toBe('undefined');
    await expect(parseTtml('<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="1s">Hi</p></div></body></tt>', {} as never)).rejects.toThrow(/browser only/);
  });
});
