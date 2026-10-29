// Settings menu level two (UI-DESIGN §7), an on-demand chunk the menu requests when it opens:
// the quality / audio / captions lists and the CVAA caption style page with its live preview.
// Level one stays in the main chunk. Helpers the main chunk also uses are handed over (a value
// import of a shared module would make it a shared, eagerly initialised chunk).

import { Activity, MessageSquareText, SlidersHorizontal } from 'lucide';
import type { CaptionStyle } from '@otter-player/text';
import type { UiState } from './context.js';
import type { MenuGroup, MenuOption, SettingsView } from './elements.js';
import type { IconNode } from './icons.js';
import type { DanmakuStrings, PictureStrings, UiStrings } from './strings.js';

/** What the settings menu lends the level views. */
export interface LevelHost {
  readonly doc: Document;
  readonly strings: UiStrings;
  /** The menu element (its closest lang attribute picks this chunk's own texts). */
  readonly el: Element;
  readonly menuId: string;
  radioRow(group: string, option: MenuOption): HTMLElement;
  /** The text renderer's cue layer, whose user variables the style preview mirrors. */
  cueLayer(): HTMLElement | null;
}

export interface LevelDeps {
  readonly icon: (node: IconNode) => string;
  readonly ChevronLeft: IconNode;
  readonly ChevronRight: IconNode;
}

const PICTURE_EN: PictureStrings = {
  picture: 'Picture',
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturate: 'Saturation',
  temperature: 'Temperature',
  sharpness: 'Sharpness',
  resetPicture: 'Original picture',
  pictureAdjusted: 'Adjusted',
  reset: 'Reset',
};
const PICTURE_ZH: PictureStrings = {
  picture: '画面',
  brightness: '亮度',
  contrast: '对比度',
  saturate: '饱和度',
  temperature: '色温',
  sharpness: '锐化',
  resetPicture: '原始画面',
  pictureAdjusted: '已调整',
  reset: '重置',
};

/** Picture page texts: the host's override over the defaults for the player's language. */
export const pictureStrings = (host: LevelHost): PictureStrings => ({
  ...(/^zh\b/i.test(host.strings.locale) ? PICTURE_ZH : PICTURE_EN),
  ...host.strings.picture,
});

const DANMAKU_EN: DanmakuStrings = {
  danmaku: 'Danmaku',
  on: 'On',
  off: 'Off',
  opacity: 'Opacity',
  fontSize: 'Font size',
  speed: 'Speed',
  slow: 'Slow',
  normal: 'Normal',
  fast: 'Fast',
  area: 'Display area',
  density: 'Density',
  low: 'Low',
  high: 'High',
  hide: 'Hide',
  scroll: 'Scrolling',
  top: 'Top',
  bottom: 'Bottom',
};
const DANMAKU_ZH: DanmakuStrings = {
  danmaku: '弹幕',
  on: '开',
  off: '关',
  opacity: '不透明度',
  fontSize: '字号',
  speed: '速度',
  slow: '慢',
  normal: '正常',
  fast: '快',
  area: '显示区域',
  density: '弹幕密度',
  low: '低',
  high: '高',
  hide: '屏蔽类型',
  scroll: '滚动',
  top: '顶部',
  bottom: '底部',
};

const danmakuStrings = (host: LevelHost): DanmakuStrings => ({
  ...(/^zh\b/i.test(host.strings.locale) ? DANMAKU_ZH : DANMAKU_EN),
  ...host.strings.danmakuPage,
});

/** A picture action as an item value: the menu dispatches it as it is. */
const pictureValue = (type: string, payload: object): string => JSON.stringify([type, payload]);

/**
 * Level one's last rows, built here so their texts and icons stay out of the main chunk: Picture,
 * and the stats switch when the player has an otter-stats element.
 */
export function extraRows(host: LevelHost, s: Readonly<UiState>, deps: LevelDeps, stats: HTMLElement | null): HTMLElement[] {
  const out = [pictureRow(host, s, deps)];
  if (s.danmaku !== undefined) out.push(danmakuRow(host, s.danmaku, deps));
  if (stats !== null) {
    const item = host.doc.createElement('div');
    item.setAttribute('role', 'menuitemcheckbox');
    item.setAttribute('aria-checked', String(!stats.hidden));
    item.dataset['action'] = 'stats';
    item.dataset['key'] = 'row:stats';
    item.tabIndex = -1;
    item.innerHTML = `<span class="ic">${deps.icon(Activity)}</span><span class="lb"></span><span class="switch" aria-hidden="true"></span>`;
    (item.querySelector('.lb') as HTMLElement).textContent = host.strings.statsForNerds;
    out.push(item);
  }
  return out;
}

function danmakuRow(host: LevelHost, d: NonNullable<UiState['danmaku']>, deps: LevelDeps): HTMLElement {
  const t = danmakuStrings(host);
  const value = d.enabled ? t.on : t.off;
  const item = host.doc.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.setAttribute('aria-haspopup', 'menu');
  item.dataset['action'] = 'open';
  item.dataset['view'] = 'danmaku';
  item.dataset['key'] = 'row:danmaku';
  item.tabIndex = -1;
  item.innerHTML = `<span class="ic">${deps.icon(MessageSquareText)}</span><span class="lb"></span><span class="val"></span><span class="chev">${deps.icon(deps.ChevronRight)}</span>`;
  (item.querySelector('.lb') as HTMLElement).textContent = t.danmaku;
  (item.querySelector('.val') as HTMLElement).textContent = value;
  item.querySelector('.val')?.toggleAttribute('data-on', d.enabled);
  item.setAttribute('aria-label', `${t.danmaku}, ${value}`);
  return item;
}

function pictureRow(host: LevelHost, s: Readonly<UiState>, deps: LevelDeps): HTMLElement {
  const t = pictureStrings(host);
  const p = s.picture;
  const parts: string[] = [];
  if (p !== undefined && p.zoom > 1.001) parts.push(`${Math.round(p.zoom * 10) / 10}×`);
  const f = p?.filters;
  if (f !== undefined && (f.brightness !== 1 || f.contrast !== 1 || f.saturate !== 1 || f.temperature !== 0 || f.sharpen !== 0)) parts.push(t.pictureAdjusted);
  const value = parts.length === 0 ? t.resetPicture : parts.join(' · ');
  const item = host.doc.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.setAttribute('aria-haspopup', 'menu');
  item.dataset['action'] = 'open';
  item.dataset['view'] = 'picture';
  item.dataset['key'] = 'row:picture';
  item.tabIndex = -1;
  item.innerHTML = `<span class="ic">${deps.icon(SlidersHorizontal)}</span><span class="lb"></span><span class="val"></span><span class="chev">${deps.icon(deps.ChevronRight)}</span>`;
  (item.querySelector('.lb') as HTMLElement).textContent = t.picture;
  (item.querySelector('.val') as HTMLElement).textContent = value;
  item.setAttribute('aria-label', `${t.picture}, ${value}`);
  return item;
}

/** CVAA caption display settings (47 CFR §79.103(c)); `value` is the action, as JSON. */
export function captionStyleGroups(s: Readonly<UiState>, strings: UiStrings): MenuGroup[] {
  const style: CaptionStyle = s.captionStyle ?? {};
  const group = <K extends keyof CaptionStyle>(id: string, label: string, key: K, values: readonly [CaptionStyle[K] | null, string][]): MenuGroup => ({
    id,
    label,
    options: values.map(([v, text]) => ({ value: JSON.stringify(['set-caption-style', { [key]: v }]), label: text, checked: (style[key] ?? null) === v })),
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
  const ps = pictureStrings(host);
  const ds = danmakuStrings(host);
  const title = view === 'quality' ? t.quality : view === 'audio' ? t.audio : view === 'captions' ? t.captions : view === 'picture' ? ps.picture : view === 'danmaku' ? ds.danmaku : t.captionStyle;
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
  if (view === 'picture') {
    const item = (key: string, label: string, value: string, checked: boolean): HTMLElement => {
      const row = doc.createElement('div');
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(checked));
      row.setAttribute('value', value);
      row.dataset['group'] = 'picture';
      row.dataset['key'] = key;
      row.tabIndex = -1;
      row.innerHTML = '<span class="lb"></span>';
      (row.querySelector('.lb') as HTMLElement).textContent = label;
      return row;
    };
    // Steps, not sliders: the menu's keyboard model is a list of radios (one press = one step).
    const row = (id: string, label: string, key: keyof NonNullable<UiState['picture']>['filters'], steps: readonly [number, string][]): void => {
      const current = s.picture?.filters?.[key] ?? 0;
      const group = doc.createElement('div');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      group.dataset['group'] = 'picture';
      const head = doc.createElement('div');
      head.className = 'gh';
      head.setAttribute('role', 'presentation');
      head.id = `${host.menuId}-${id}`;
      head.textContent = label;
      group.setAttribute('aria-labelledby', head.id);
      const seg = doc.createElement('div');
      seg.className = 'seg';
      for (const [v, text] of steps) seg.append(item(`${id}:${v}`, text, pictureValue('set-filters', { filters: { [key]: v } }), Math.abs(current - v) < 1e-6));
      group.append(head, seg);
      out.push(group);
    };
    row('picture-brightness', ps.brightness, 'brightness', [[0.75, '75%'], [1, '100%'], [1.25, '125%']]);
    row('picture-contrast', ps.contrast, 'contrast', [[0.75, '75%'], [1, '100%'], [1.25, '125%']]);
    row('picture-saturate', ps.saturate, 'saturate', [[0.5, '50%'], [1, '100%'], [1.5, '150%']]);
    row('picture-temperature', ps.temperature, 'temperature', [[-0.5, '−'], [0, ps.reset], [0.5, '+']]);
    row('picture-sharpen', ps.sharpness, 'sharpen', [[0, ps.reset], [0.3, '30%'], [0.6, '60%']]);
    const neutral = s.picture === undefined || (s.picture.zoom === 1 && JSON.stringify(s.picture.filters) === JSON.stringify({ brightness: 1, contrast: 1, saturate: 1, temperature: 0, sharpen: 0 }));
    out.push(item('picture-reset', ps.resetPicture, pictureValue('reset-picture', {}), neutral));
    return out;
  }
  if (view === 'danmaku') {
    const d = s.danmaku;
    if (d === undefined) return out;
    // One segmented control per setting; the hide types are switches.
    const seg = (id: string, label: string, options: readonly [string, object, boolean][], role = 'menuitemradio'): void => {
      const group = doc.createElement('div');
      group.setAttribute('role', 'group');
      group.dataset['group'] = 'danmaku';
      const head = doc.createElement('div');
      head.className = 'gh';
      head.setAttribute('role', 'presentation');
      head.id = `${host.menuId}-${id}`;
      head.textContent = label;
      group.setAttribute('aria-labelledby', head.id);
      const row = doc.createElement('div');
      row.className = 'seg';
      options.forEach(([text, patch, checked], i) => {
        const b = doc.createElement('div');
        b.setAttribute('role', role);
        b.setAttribute('aria-checked', String(checked));
        b.setAttribute('value', pictureValue('set-danmaku', patch));
        b.dataset['group'] = 'danmaku';
        b.dataset['key'] = `${id}:${i}`;
        b.tabIndex = -1;
        b.textContent = text;
        row.append(b);
      });
      group.append(head, row);
      out.push(group);
    };
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
    const steps = (key: keyof typeof d, values: readonly [string, number][]): [string, object, boolean][] => values.map(([text, v]) => [text, { [key]: v }, near(d[key] as number, v)]);
    seg('danmaku-enabled', ds.danmaku, [
      [ds.on, { enabled: true }, d.enabled],
      [ds.off, { enabled: false }, !d.enabled],
    ]);
    seg('danmaku-opacity', ds.opacity, steps('opacity', [['25%', 0.25], ['50%', 0.5], ['75%', 0.75], ['100%', 1]]));
    seg('danmaku-size', ds.fontSize, steps('fontScale', [['75%', 0.75], ['100%', 1], ['125%', 1.25], ['150%', 1.5]]));
    seg('danmaku-speed', ds.speed, steps('speed', [[ds.slow, 0.75], [ds.normal, 1], [ds.fast, 1.5]]));
    seg('danmaku-area', ds.area, steps('area', [['1/4', 0.25], ['1/2', 0.5], ['3/4', 0.75], ['100%', 1]]));
    seg('danmaku-density', ds.density, steps('density', [[ds.low, 0.3], [ds.normal, 0.6], [ds.high, 1]]));
    seg(
      'danmaku-hide',
      ds.hide,
      [
        [ds.scroll, { hideScroll: !d.hideScroll }, d.hideScroll],
        [ds.top, { hideTop: !d.hideTop }, d.hideTop],
        [ds.bottom, { hideBottom: !d.hideBottom }, d.hideBottom],
      ],
      'menuitemcheckbox',
    );
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
