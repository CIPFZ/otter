// Settings menu level two (UI-DESIGN §7), an on-demand chunk the menu requests when it opens:
// the quality / audio / captions lists and the CVAA caption style page with its live preview.
// Level one stays in the main chunk. Helpers the main chunk also uses are handed over (a value
// import of a shared module would make it a shared, eagerly initialised chunk).

import type { CaptionStyle } from '@otter-player/text';
import type { UiState } from './context.js';
import type { MenuGroup, MenuOption, SettingsView } from './elements.js';
import type { IconNode } from './icons.js';
import type { UiStrings } from './strings.js';

/** What the settings menu lends the level views. */
export interface LevelHost {
  readonly doc: Document;
  readonly strings: UiStrings;
  readonly menuId: string;
  radioRow(group: string, option: MenuOption): HTMLElement;
  /** The text renderer's cue layer, whose user variables the style preview mirrors. */
  cueLayer(): HTMLElement | null;
}

export interface LevelDeps {
  readonly icon: (node: IconNode) => string;
  readonly ChevronLeft: IconNode;
}

/** CVAA caption display settings (47 CFR §79.103(c)); `value` is the JSON style patch. */
export function captionStyleGroups(s: Readonly<UiState>, strings: UiStrings): MenuGroup[] {
  const style: CaptionStyle = s.captionStyle ?? {};
  const group = <K extends keyof CaptionStyle>(id: string, label: string, key: K, values: readonly [CaptionStyle[K] | null, string][]): MenuGroup => ({
    id,
    label,
    options: values.map(([v, text]) => ({ value: JSON.stringify({ [key]: v }), label: text, checked: (style[key] ?? null) === v })),
  });
  return [
    group('caption-size', strings.captionSize, 'scale', [[null, strings.styleDefault], [0.75, '75%'], [1.5, '150%'], [2, '200%']]),
    group('caption-color', strings.captionColor, 'color', [[null, strings.styleDefault], ['#ffffff', strings.colorWhite], ['#ffff00', strings.colorYellow], ['#00ffff', strings.colorCyan], ['#00ff00', strings.colorGreen]]),
    group('caption-background', strings.captionBackground, 'backgroundOpacity', [[null, strings.styleDefault], [0, strings.backgroundNone], [0.5, strings.backgroundSemi], [1, strings.backgroundOpaque]]),
    group('caption-window', strings.captionWindow, 'windowOpacity', [[null, strings.styleDefault], [0.5, strings.backgroundSemi], [1, strings.backgroundOpaque]]),
    group('caption-edge', strings.captionEdge, 'edge', [[null, strings.styleDefault], ['none', strings.edgeNone], ['shadow', strings.edgeShadow], ['outline', strings.edgeOutline], ['raised', strings.edgeRaised], ['depressed', strings.edgeDepressed]]),
    group('caption-font', strings.captionFont, 'font', [[null, strings.styleDefault], ['serif', strings.fontSerif], ['monospace', strings.fontMonospace], ['casual', strings.fontCasual]]),
  ];
}

const PREVIEW_VARS = ['--otter-cue-user-scale', '--otter-cue-user-color', '--otter-cue-user-background', '--otter-cue-user-window', '--otter-cue-user-shadow', '--otter-cue-user-font'];

function applyPreview(host: LevelHost, preview: HTMLElement): void {
  // Mirror the cue layer's user variables (set by the text renderer on its layer element).
  const layer = host.cueLayer();
  for (const v of PREVIEW_VARS) {
    const value = layer?.style.getPropertyValue(v) ?? '';
    if (value !== '') preview.style.setProperty(v, value);
  }
}

/** Items of one level-two view: a back row, then its list or the caption style page. */
export function buildLevel(host: LevelHost, view: Exclude<SettingsView, 'root'>, s: Readonly<UiState>, groups: readonly MenuGroup[], deps: LevelDeps): HTMLElement[] {
  const { doc, strings: t } = host;
  const back = doc.createElement('div');
  back.setAttribute('role', 'menuitem');
  back.className = 'back';
  back.dataset['action'] = 'back';
  back.dataset['key'] = 'back';
  back.tabIndex = -1;
  const title = view === 'quality' ? t.quality : view === 'audio' ? t.audio : view === 'captions' ? t.captions : t.captionStyle;
  back.innerHTML = `<span class="ic">${deps.icon(deps.ChevronLeft)}</span><span class="lb"></span>`;
  (back.querySelector('.lb') as HTMLElement).textContent = title;
  back.setAttribute('aria-label', `${t.back}: ${title}`);
  const out: HTMLElement[] = [back];
  if (view === 'caption-style') {
    // Live preview of the current caption style (decorative; the cues themselves update too).
    const preview = doc.createElement('div');
    preview.className = 'preview';
    preview.setAttribute('aria-hidden', 'true');
    preview.append(Object.assign(doc.createElement('span'), { textContent: t.captionPreview }));
    applyPreview(host, preview);
    out.push(preview);
    for (const g of captionStyleGroups(s, t)) {
      const group = doc.createElement('div');
      group.setAttribute('role', 'group');
      group.dataset['group'] = g.id;
      const head = doc.createElement('div');
      head.className = 'gh';
      head.setAttribute('role', 'presentation');
      head.id = `${host.menuId}-${g.id}`;
      head.textContent = g.label;
      group.setAttribute('aria-labelledby', head.id);
      const seg = doc.createElement('div');
      seg.className = 'seg';
      for (const o of g.options) {
        const b = doc.createElement('div');
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(o.checked));
        b.setAttribute('value', o.value);
        b.dataset['group'] = g.id;
        b.dataset['key'] = `${g.id}:${o.value}`;
        b.tabIndex = -1;
        b.textContent = o.label;
        seg.append(b);
      }
      group.append(head, seg);
      out.push(group);
    }
    return out;
  }
  const g = groups.find((x) => x.id === view);
  if (g !== undefined) {
    const group = doc.createElement('div');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', g.label);
    group.dataset['group'] = g.id;
    group.append(...g.options.map((o) => host.radioRow(g.id, o)));
    out.push(group);
  }
  return out;
}
