// @vitest-environment happy-dom
// Document Picture-in-Picture moves the player into another window's document. What the elements
// build there (document.createElement of that document) and that document's own nodes belong to
// that window's realm: they are not instances of this realm's HTMLElement / Element.
import { describe, expect, it } from 'vitest';
import { createStore } from '@otter-player/core';
import { MEDIA_SLICE } from '@otter-player/media';
import { PLAYER_UI_SLICE, defineOtterElements, provideStore, uiLanguage, type UiActions, type UiState } from '@otter-player/ui-core';

defineOtterElements();

/**
 * `el` as code in this realm sees an element of another window: it works like an element, but its
 * prototype chain has none of this realm's DOM classes (happy-dom shares them between windows).
 */
const foreign = <T extends Element>(el: T): T =>
  new Proxy(el, {
    getPrototypeOf: () => Object.prototype,
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

describe('elements in another window (Document PiP)', () => {
  it('a menu row built by the other window\'s document is still chosen on click', () => {
    const store = createStore<UiState, UiActions>({ slices: [MEDIA_SLICE, PLAYER_UI_SLICE] });
    const rates: number[] = [];
    store.handle('set-playback-rate', ({ rate }) => void rates.push(rate));
    store.handle('open-menu', ({ id }) => store.setState({ menu: id }));
    const root = document.createElement('div');
    root.innerHTML = '<otter-speed-menu></otter-speed-menu>';
    document.body.replaceChildren(root);
    provideStore(root, store.view());
    const menu = root.querySelector('otter-speed-menu') as HTMLElement;
    const shadow = menu.shadowRoot as ShadowRoot;
    (shadow.querySelector('button') as HTMLElement).click();
    const list = shadow.querySelector('[role="menu"]') as HTMLElement;
    // A row as the menu builds it while in the PiP window: an element of that window's realm.
    const row = foreign(document.createElement('div'));
    expect(row instanceof HTMLElement).toBe(false);
    row.setAttribute('role', 'menuitemradio');
    row.setAttribute('value', '1.5');
    row.dataset['group'] = 'speed';
    const click = new MouseEvent('click', { bubbles: true, composed: true });
    Object.defineProperty(click, 'composedPath', { value: () => [row, list, shadow, menu, root] });
    list.dispatchEvent(click);
    // The choice arrives (this synthetic click reaches the store twice, a same-realm row too).
    expect(rates.length).toBeGreaterThan(0);
    expect(new Set(rates)).toEqual(new Set([1.5]));
  });

  it('the UI language comes from the player\'s lang attribute in the other window too', () => {
    const root = foreign(document.createElement('div'));
    root.setAttribute('lang', 'zh-CN');
    const inner = document.createElement('span');
    Object.defineProperty(inner, 'parentNode', { value: root });
    expect(uiLanguage(inner)).toBe('zh-CN');
  });
});
