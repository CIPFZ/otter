// Companion mode texts (ADR-016): the defaults by language, shared by the settings page's chunk
// and the companion window's controls chunk (a module of its own, so neither pulls in the other).

import type { CompanionStrings, UiStrings } from './strings.js';

const COMPANION_EN: CompanionStrings = { companion: 'Floating player', dim: 'Dimming', audioOnly: 'Audio only', showPicture: 'Show picture', on: 'On', off: 'Off' };
const COMPANION_ZH: CompanionStrings = { companion: '悬浮窗', dim: '暗化', audioOnly: '纯音频条', showPicture: '显示画面', on: '开', off: '关' };

/** Companion texts: the host's override over the defaults for the player's language. */
export const companionStrings = (strings: UiStrings): CompanionStrings => ({
  ...(/^zh\b/i.test(strings.locale) ? COMPANION_ZH : COMPANION_EN),
  ...strings.companionPage,
});
