// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createCore } from '@otter-player/core';
import { createInputController, DEFAULT_GESTURES, DEFAULT_HOTKEYS, type InputAction, type InputActionMap } from '@otter-player/input';

async function setup(over: { modal?: boolean; timings?: { doubleMs?: number; longPressMs?: number } } = {}) {
  const core = createCore<object, InputActionMap>();
  const actions: [string, unknown][] = [];
  const controller = createInputController({
    store: core.store.view(),
    modal: () => over.modal ?? false,
    ...(over.timings === undefined ? {} : { timings: over.timings }),
  });
  // Record every default-mapped action by registering handlers.
  const types = new Set([...Object.values(DEFAULT_HOTKEYS), ...Object.values(DEFAULT_GESTURES)].map((a) => a.type));
  for (const type of types) core.store.handle(type, (payload) => void actions.push([type, payload]));
  const root = document.createElement('div');
  root.tabIndex = -1;
  const button = document.createElement('button');
  const slider = document.createElement('input');
  slider.type = 'range';
  const text = document.createElement('input');
  root.append(button, slider, text);
  document.body.replaceChildren(root);
  controller.attach(root);
  const key = (k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    (document.activeElement ?? root).dispatchEvent(e);
    return e;
  };
  return { actions, root, button, slider, text, key, controller };
}

describe('InputController keyboard (SPEC §14.3)', () => {
  it('maps the default hotkeys and prevents the defaults it handles', async () => {
    const { actions, key, root } = await setup();
    root.focus();
    expect(key(' ').defaultPrevented).toBe(true);
    key('k');
    key('l');
    key('ArrowLeft');
    key('ArrowUp');
    key('f');
    key('5');
    key('C');
    expect(actions).toEqual([
      ['toggle-paused', {}],
      ['toggle-paused', {}],
      ['seek-by', { seconds: 10 }],
      ['seek-by', { seconds: -10 }],
      ['volume-by', { delta: 0.05 }],
      ['toggle-fullscreen', {}],
      ['seek-to-percent', { percent: 50 }],
      ['toggle-captions', {}],
    ]);
  });

  it('leaves keys to the focused control: buttons, sliders, text fields, modifiers', async () => {
    const { actions, key, button, slider, text, root } = await setup();
    button.focus();
    key(' ');
    slider.focus();
    key('ArrowLeft');
    text.focus();
    key('k');
    root.focus();
    key('f', { ctrlKey: true });
    expect(actions).toEqual([]);
  });

  it('ignores key repeat for toggles but lets seeks repeat', async () => {
    const { actions, key, root } = await setup();
    root.focus();
    key('k', { repeat: true });
    key('ArrowRight', { repeat: true });
    expect(actions).toEqual([['seek-by', { seconds: 10 }]]);
  });

  it('traps Tab inside the player only while modal', async () => {
    const inline = await setup({ modal: false });
    inline.text.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    inline.text.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);

    const modal = await setup({ modal: true });
    modal.text.focus();
    const wrap = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    modal.text.dispatchEvent(wrap);
    // The last focusable wraps to the first.
    expect(wrap.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(modal.button);
    const back = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    modal.button.dispatchEvent(back);
    expect(document.activeElement).toBe(modal.text);
  });
});

describe('InputController pointer (SPEC §14.3)', () => {
  const ptr = (el: HTMLElement, type: string, init: PointerEventInit): boolean =>
    el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, ...init }));
  const rect = (el: HTMLElement, width: number, height: number): void => {
    el.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  };
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('touch tap defers; a second tap in time becomes a zone double tap', async () => {
    const { actions, root } = await setup({ timings: { doubleMs: 40 } });
    rect(root, 300, 200);
    ptr(root, 'pointerdown', { pointerId: 1, clientX: 150, clientY: 10 });
    ptr(root, 'pointerup', { pointerId: 1, clientX: 150, clientY: 10 });
    expect(actions).toEqual([]);
    await wait(80);
    expect(actions).toEqual([['toggle-controls', {}]]);

    actions.length = 0;
    for (const id of [3, 4]) {
      ptr(root, 'pointerdown', { pointerId: id, clientX: 10, clientY: 10 });
      ptr(root, 'pointerup', { pointerId: id, clientX: 10, clientY: 10 });
    }
    await wait(80);
    expect(actions).toEqual([['seek-by', { seconds: -10 }]]);

    actions.length = 0;
    for (const id of [5, 6]) {
      ptr(root, 'pointerdown', { pointerId: id, clientX: 290, clientY: 10 });
      ptr(root, 'pointerup', { pointerId: id, clientX: 290, clientY: 10 });
    }
    await wait(80);
    expect(actions).toEqual([['seek-by', { seconds: 10 }]]);
  });

  it('long press holds 2x until release', async () => {
    const { actions, root } = await setup({ timings: { longPressMs: 20 } });
    ptr(root, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    await wait(40);
    ptr(root, 'pointerup', { pointerId: 1, clientX: 100, clientY: 100 });
    await wait(400);
    expect(actions).toEqual([
      ['hold-rate', { rate: 2 }],
      ['hold-rate', { rate: 0 }],
    ]);
  });

  it('vertical swipe on the half it started in adjusts volume or brightness', async () => {
    const { actions, root } = await setup();
    rect(root, 400, 400);
    ptr(root, 'pointerdown', { pointerId: 1, clientX: 300, clientY: 300 });
    ptr(root, 'pointermove', { pointerId: 1, clientX: 300, clientY: 200 });
    ptr(root, 'pointerup', { pointerId: 1, clientX: 300, clientY: 200 });
    expect(actions[0]?.[0]).toBe('volume-by');
    expect((actions[0]?.[1] as { delta: number }).delta).toBeCloseTo(0.25);
    actions.length = 0;
    ptr(root, 'pointerdown', { pointerId: 2, clientX: 100, clientY: 300 });
    ptr(root, 'pointermove', { pointerId: 2, clientX: 100, clientY: 350 });
    ptr(root, 'pointerup', { pointerId: 2, clientX: 100, clientY: 350 });
    expect(actions[0]?.[0]).toBe('brightness-by');
    expect((actions[0]?.[1] as { delta: number }).delta).toBeCloseTo(-0.125);
  });

  it('horizontal swipe previews and commits the seek on release', async () => {
    const { actions, root } = await setup();
    rect(root, 400, 200);
    ptr(root, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    ptr(root, 'pointermove', { pointerId: 1, clientX: 300, clientY: 100 });
    expect(actions.at(-1)).toEqual(['seek-preview', { seconds: 50 }]);
    ptr(root, 'pointerup', { pointerId: 1, clientX: 300, clientY: 100 });
    expect(actions.at(-1)).toEqual(['seek-preview', { seconds: 50, commit: true }]);
  });

  it('pinch reports the scale relative to the start distance', async () => {
    const { actions, root } = await setup();
    ptr(root, 'pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
    ptr(root, 'pointerdown', { pointerId: 2, clientX: 200, clientY: 100, isPrimary: false });
    ptr(root, 'pointermove', { pointerId: 2, clientX: 300, clientY: 100, isPrimary: false });
    expect(actions.at(-1)?.[0]).toBe('zoom');
    expect((actions.at(-1)?.[1] as { scale: number }).scale).toBeCloseTo(2);
  });

  it('mouse click and double-click; taps on chrome are not gestures', async () => {
    const { actions, root, button } = await setup({ timings: { doubleMs: 10 } });
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    root.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(actions).toEqual([
      ['toggle-paused', {}],
      ['toggle-fullscreen', {}],
    ]);
    actions.length = 0;
    ptr(button, 'pointerdown', { pointerId: 9, clientX: 5, clientY: 5 });
    ptr(button, 'pointerup', { pointerId: 9, clientX: 5, clientY: 5 });
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(30);
    expect(actions).toEqual([]);
  });

  it('remapping takes effect immediately', async () => {
    const { actions, key, root, controller } = await setup();
    root.focus();
    controller.setHotkeys({ x: { type: 'toggle-pip' } as InputAction });
    key('k');
    key('x');
    expect(actions).toEqual([['toggle-pip', {}]]);
  });
});
