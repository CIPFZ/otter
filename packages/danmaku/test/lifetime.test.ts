// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCore } from '@otter-player/core';
import { createDanmaku, DANMAKU_SLICE, type DanmakuActionMap, type DanmakuState } from '../src/index.js';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

async function setup() {
  const danmaku = createDanmaku();
  const core = createCore<DanmakuState & { source: null }, DanmakuActionMap>({
    slices: [DANMAKU_SLICE, { id: 'media-test', initialState: { source: null } }],
    plugins: [danmaku.plugin],
  });
  await core.start();
  return { danmaku, core };
}

describe('mask lifetime', () => {
  it.each(['plugin', 'overlay'] as const)('releases a loaded WebM mask when the %s is destroyed', async (owner) => {
    vi.useFakeTimers();
    const { danmaku, core } = await setup();
    core.store.dispatch('load-danmaku-mask', { kind: 'webm', url: 'data:video/webm;base64,' });
    await vi.dynamicImportSettled();
    expect(document.querySelectorAll('video[aria-hidden=true]')).toHaveLength(1);
    if (owner === 'plugin') await core.destroy();
    else danmaku.overlay.destroy();
    expect(document.querySelectorAll('video[aria-hidden=true]')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    danmaku.overlay.destroy();
    await core.destroy();
  });

  it('does not attach a mask whose module finishes loading after uninstall', async () => {
    const { danmaku, core } = await setup();
    core.store.dispatch('load-danmaku-mask', { kind: 'webm', url: 'data:video/webm;base64,' });
    await core.destroy();
    danmaku.overlay.destroy();
    await vi.dynamicImportSettled();
    expect(document.querySelectorAll('video[aria-hidden=true]')).toHaveLength(0);
  });
});
