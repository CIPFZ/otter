// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { createCore } from '@otter-player/core';
import { createOverlayLayer, type Overlay, type OverlayHost, type Surface } from '@otter-player/surface';

const surfaceFor = (element: HTMLVideoElement): Surface =>
  ({ element, contentRect: new DOMRect(0, 60, 640, 360), onContentRectChange: () => () => undefined }) as unknown as Surface;

describe('createOverlayLayer', () => {
  it('mounts overlays above the picture, forwards the safe area and ticks them from one rAF', async () => {
    const container = document.createElement('div');
    const video = document.createElement('video');
    const controls = document.createElement('div');
    container.append(video, controls);
    document.body.appendChild(container);
    const core = createCore();
    let time = 3;
    const layer = createOverlayLayer({ container, surface: surfaceFor(video), store: core.store.view(), mediaTime: () => time });
    expect(container.children[1]).toBe(layer.element);

    let host: OverlayHost | undefined;
    const overlay: Overlay = {
      id: 'probe',
      zIndex: 5,
      mount: (h) => void (host = h),
      tick: vi.fn(),
      setSafeArea: vi.fn(),
      destroy: vi.fn(),
    };
    const remove = layer.add(overlay);
    expect(host?.root.dataset['overlay']).toBe('probe');
    expect(host?.contentRect.y).toBe(60);
    layer.setSafeArea({ top: 0, right: 0, bottom: 48, left: 0 });
    expect(overlay.setSafeArea).toHaveBeenLastCalledWith({ top: 0, right: 0, bottom: 48, left: 0 });
    expect(host?.safeArea.bottom).toBe(48);

    await new Promise((r) => setTimeout(r, 50));
    time = 4;
    await new Promise((r) => setTimeout(r, 50));
    expect(overlay.tick).toHaveBeenCalled();
    expect((overlay.tick as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toBe(4);

    remove();
    expect(overlay.destroy).toHaveBeenCalledOnce();
    expect(layer.element.children).toHaveLength(0);
    layer.destroy();
    expect(container.contains(layer.element)).toBe(false);
  });
});
