// UI strings (ADR-005 §6): primitives never hard-code text. English and Chinese ship; a host
// swaps or extends the table with provideStrings(). `{n}` / `{label}` are placeholders.

export interface UiStrings {
  readonly play: string;
  readonly pause: string;
  readonly mute: string;
  readonly unmute: string;
  readonly volume: string;
  readonly seek: string;
  /** "{current} of {duration}" */
  readonly timeOf: string;
  readonly live: string;
  readonly behindLive: string;
  readonly captions: string;
  readonly captionsOff: string;
  readonly settings: string;
  readonly quality: string;
  /** "Auto ({label})" when the playing rendition is known. */
  readonly qualityAuto: string;
  readonly qualityAutoActive: string;
  readonly speed: string;
  readonly speedNormal: string;
  readonly fullscreen: string;
  readonly exitFullscreen: string;
  readonly pip: string;
  readonly exitPip: string;
  readonly theater: string;
  readonly exitTheater: string;
  readonly cast: string;
  readonly stopCast: string;
  readonly airplay: string;
  readonly closeMini: string;
  readonly audio: string;
  // Caption display settings (CVAA).
  readonly captionSize: string;
  readonly captionColor: string;
  readonly captionBackground: string;
  readonly captionWindow: string;
  readonly captionEdge: string;
  readonly captionFont: string;
  readonly styleDefault: string;
  readonly colorWhite: string;
  readonly colorYellow: string;
  readonly colorCyan: string;
  readonly colorGreen: string;
  readonly backgroundNone: string;
  readonly backgroundSemi: string;
  readonly backgroundOpaque: string;
  readonly edgeNone: string;
  readonly edgeShadow: string;
  readonly edgeOutline: string;
  readonly edgeRaised: string;
  readonly edgeDepressed: string;
  readonly fontSerif: string;
  readonly fontMonospace: string;
  readonly fontCasual: string;
  readonly captionStyle: string;
  /** Sample text in the caption style preview. */
  readonly captionPreview: string;
  readonly back: string;
  readonly statsForNerds: string;
  readonly copy: string;
  readonly close: string;
  /** "Back {n} seconds" */
  readonly seekBack: string;
  readonly seekForward: string;
  readonly backToLive: string;
  readonly errorTitle: string;
  readonly retry: string;
  readonly statsPlayback: string;
  readonly statsNetwork: string;
  readonly statsQuality: string;
  readonly loading: string;
  readonly player: string;
  readonly statistics: string;
  // Announcer (aria-live) messages.
  readonly announcePlaying: string;
  readonly announcePaused: string;
  readonly announceMuted: string;
  readonly announceUnmuted: string;
  /** "Volume {n}%" */
  readonly announceVolume: string;
  /** "Captions on: {label}" */
  readonly announceCaptionsOn: string;
  readonly announceCaptionsOff: string;
  /** "Quality {label}" */
  readonly announceQuality: string;
  /** "Speed {n}x" */
  readonly announceSpeed: string;
  /** "Playback error: {label}" */
  readonly announceError: string;
  readonly announceFullscreen: string;
  readonly announceExitFullscreen: string;
}

export const STRINGS_EN: UiStrings = {
  play: 'Play',
  pause: 'Pause',
  mute: 'Mute',
  unmute: 'Unmute',
  volume: 'Volume',
  seek: 'Seek',
  timeOf: '{current} of {duration}',
  live: 'Live',
  behindLive: 'Behind live',
  captions: 'Captions',
  captionsOff: 'Off',
  settings: 'Settings',
  quality: 'Quality',
  qualityAuto: 'Auto',
  qualityAutoActive: 'Auto ({label})',
  speed: 'Speed',
  speedNormal: 'Normal',
  fullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  pip: 'Picture in picture',
  exitPip: 'Exit picture in picture',
  theater: 'Theater mode',
  exitTheater: 'Default view',
  cast: 'Cast',
  stopCast: 'Casting',
  airplay: 'AirPlay',
  closeMini: 'Close mini player',
  audio: 'Audio',
  captionSize: 'Caption size',
  captionColor: 'Caption color',
  captionBackground: 'Caption background',
  captionWindow: 'Caption window',
  captionEdge: 'Caption edge',
  captionFont: 'Caption font',
  styleDefault: 'Default',
  colorWhite: 'White',
  colorYellow: 'Yellow',
  colorCyan: 'Cyan',
  colorGreen: 'Green',
  backgroundNone: 'None',
  backgroundSemi: 'Semi-transparent',
  backgroundOpaque: 'Opaque',
  edgeNone: 'None',
  edgeShadow: 'Drop shadow',
  edgeOutline: 'Outline',
  edgeRaised: 'Raised',
  edgeDepressed: 'Depressed',
  fontSerif: 'Serif',
  fontMonospace: 'Monospace',
  fontCasual: 'Casual',
  captionStyle: 'Caption style',
  captionPreview: 'Captions look like this',
  back: 'Back',
  statsForNerds: 'Stats for nerds',
  copy: 'Copy as JSON',
  close: 'Close',
  seekBack: 'Back {n} seconds',
  seekForward: 'Forward {n} seconds',
  backToLive: 'Back to live',
  errorTitle: 'This video can’t be played',
  retry: 'Retry',
  statsPlayback: 'Playback',
  statsNetwork: 'Network',
  statsQuality: 'Quality',
  loading: 'Loading',
  player: 'Video player',
  statistics: 'Playback statistics',
  announcePlaying: 'Playing',
  announcePaused: 'Paused',
  announceMuted: 'Muted',
  announceUnmuted: 'Unmuted',
  announceVolume: 'Volume {n}%',
  announceCaptionsOn: 'Captions on: {label}',
  announceCaptionsOff: 'Captions off',
  announceQuality: 'Quality {label}',
  announceSpeed: 'Speed {n}x',
  announceError: 'Playback error: {label}',
  announceFullscreen: 'Fullscreen',
  announceExitFullscreen: 'Exited fullscreen',
};

export const STRINGS_ZH: UiStrings = {
  play: '播放',
  pause: '暂停',
  mute: '静音',
  unmute: '取消静音',
  volume: '音量',
  seek: '进度',
  timeOf: '{current}，共 {duration}',
  live: '直播',
  behindLive: '落后直播',
  captions: '字幕',
  captionsOff: '关闭',
  settings: '设置',
  quality: '清晰度',
  qualityAuto: '自动',
  qualityAutoActive: '自动（{label}）',
  speed: '倍速',
  speedNormal: '正常',
  fullscreen: '全屏',
  exitFullscreen: '退出全屏',
  pip: '画中画',
  exitPip: '退出画中画',
  theater: '剧场模式',
  exitTheater: '默认视图',
  cast: '投屏',
  stopCast: '投屏中',
  airplay: 'AirPlay',
  closeMini: '关闭小窗',
  audio: '音轨',
  captionSize: '字幕大小',
  captionColor: '字幕颜色',
  captionBackground: '字幕背景',
  captionWindow: '字幕窗口',
  captionEdge: '字幕描边',
  captionFont: '字幕字体',
  styleDefault: '默认',
  colorWhite: '白色',
  colorYellow: '黄色',
  colorCyan: '青色',
  colorGreen: '绿色',
  backgroundNone: '无',
  backgroundSemi: '半透明',
  backgroundOpaque: '不透明',
  edgeNone: '无',
  edgeShadow: '阴影',
  edgeOutline: '描边',
  edgeRaised: '凸起',
  edgeDepressed: '凹陷',
  fontSerif: '衬线',
  fontMonospace: '等宽',
  fontCasual: '手写',
  captionStyle: '字幕样式',
  captionPreview: '字幕效果预览',
  back: '返回',
  statsForNerds: '统计信息',
  copy: '复制为 JSON',
  close: '关闭',
  seekBack: '后退 {n} 秒',
  seekForward: '前进 {n} 秒',
  backToLive: '回到直播',
  errorTitle: '视频无法播放',
  retry: '重试',
  statsPlayback: '播放',
  statsNetwork: '网络',
  statsQuality: '质量',
  loading: '加载中',
  player: '视频播放器',
  statistics: '播放统计',
  announcePlaying: '正在播放',
  announcePaused: '已暂停',
  announceMuted: '已静音',
  announceUnmuted: '已取消静音',
  announceVolume: '音量 {n}%',
  announceCaptionsOn: '字幕已开启：{label}',
  announceCaptionsOff: '字幕已关闭',
  announceQuality: '清晰度 {label}',
  announceSpeed: '倍速 {n}x',
  announceError: '播放出错：{label}',
  announceFullscreen: '已进入全屏',
  announceExitFullscreen: '已退出全屏',
};

const tables = new WeakMap<Node, UiStrings>();

/** Strings for every primitive under `root` (default: from the closest `lang`, en or zh). */
export function provideStrings(root: Node, strings: UiStrings): void {
  tables.set(root, strings);
}

export function findStrings(from: Node): UiStrings {
  let node: Node | null = from;
  while (node !== null) {
    const table = tables.get(node);
    if (table !== undefined) return table;
    const lang = node instanceof Element ? node.getAttribute('lang') : null;
    if (lang !== null && lang !== '') return /^zh\b/i.test(lang) ? STRINGS_ZH : STRINGS_EN;
    node = node.parentNode ?? ((node as { host?: Node }).host ?? null);
  }
  return STRINGS_EN;
}

/** `format('Volume {n}%', { n: 50 })` */
export const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (values[k] === undefined ? m : String(values[k])));
