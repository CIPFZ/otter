// @vitest-environment happy-dom
// Which strings table the controls use (ADR-005 §6, M6 i18n): the host's table, the nearest
// `lang` (across shadow roots), the browser's language, English; spoken times in that language.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findStrings, provideStrings, speakTime, STRINGS_EN, STRINGS_ZH, uiLanguage } from '@otter-player/ui-core';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('strings table', () => {
  it('falls back to the browser language when no element has a lang', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' });
    const el = document.createElement('div');
    document.body.append(el);
    expect(findStrings(el)).toBe(STRINGS_ZH);
    vi.stubGlobal('navigator', { language: 'fr-FR' });
    expect(findStrings(el)).toBe(STRINGS_EN);
  });

  it('takes the nearest lang over the browser language, also from inside a shadow root', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });
    const player = document.createElement('div');
    player.lang = 'zh-CN';
    const host = document.createElement('span');
    player.append(host);
    document.body.append(player);
    const inner = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    inner.append(button);
    expect(uiLanguage(button)).toBe('zh-CN');
    expect(findStrings(button)).toBe(STRINGS_ZH);
  });

  it("takes the host's table over any lang", () => {
    const player = document.createElement('div');
    player.lang = 'zh';
    const custom = { ...STRINGS_EN, locale: 'en-GB', play: 'Play now' };
    provideStrings(player, custom);
    const child = document.createElement('i');
    player.append(child);
    expect(findStrings(child)).toBe(custom);
  });

  it('speaks durations in the table language', () => {
    expect(speakTime(3725, STRINGS_ZH)).toBe('1 小时 2 分钟 5 秒');
    expect(speakTime(61, STRINGS_EN)).toBe('1 minute 1 second');
    expect(speakTime(0, STRINGS_ZH)).toBe('0 秒');
    expect(speakTime(Number.NaN, STRINGS_ZH)).toBe('未知');
  });

  it('ships the same keys in both languages (the type guarantees it; this guards casts)', () => {
    expect(Object.keys(STRINGS_ZH).sort()).toEqual(Object.keys(STRINGS_EN).sort());
  });
});
