// UI strings (ADR-005 §6): primitives never hard-code text. English and Chinese ship; a host
// swaps or extends the table with provideStrings(). `{n}` / `{label}` are placeholders.
// Which table: the host's (provideStrings) -> the nearest `lang` attribute (across shadow roots;
// a preset's `lang` option sets it on the player) -> navigator.language -> English. Numbers and
// times (0:09, 720P, 1.0x) are not translated.

/** Danmaku (scrolling comments) settings page texts (level-two chunk), when the host installs `@otter-player/danmaku`. */
export interface DanmakuStrings {
  /** Page title and settings row; en "Danmaku". */
  readonly danmaku: string;
  /** Switch value; en "On". */
  readonly on: string;
  /** Switch value; en "Off". */
  readonly off: string;
  /** Opacity row; en "Opacity". */
  readonly opacity: string;
  /** Font size row; en "Font size". */
  readonly fontSize: string;
  /** Speed row; en "Speed". */
  readonly speed: string;
  /** Speed value; en "Slow". */
  readonly slow: string;
  /** Speed value; en "Normal". */
  readonly normal: string;
  /** Speed value; en "Fast". */
  readonly fast: string;
  /** Display area row; en "Display area". */
  readonly area: string;
  /** Density row; en "Density". */
  readonly density: string;
  /** Density value; en "Low". */
  readonly low: string;
  /** Density value; en "High". */
  readonly high: string;
  /** Hide-by-type row; en "Hide". */
  readonly hide: string;
  /** Comment type: scrolling; en "Scrolling". */
  readonly scroll: string;
  /** Comment type: fixed at the top; en "Top". */
  readonly top: string;
  /** Comment type: fixed at the bottom; en "Bottom". */
  readonly bottom: string;
}

/** Texts of the picture page of the settings menu (brightness, contrast, ...). */
export interface PictureStrings {
  /** Page title and settings row; en "Picture". */
  readonly picture: string;
  /** Brightness slider; en "Brightness". */
  readonly brightness: string;
  /** Contrast slider; en "Contrast". */
  readonly contrast: string;
  /** Saturation slider; en "Saturation". */
  readonly saturate: string;
  /** Colour temperature slider; en "Temperature". */
  readonly temperature: string;
  /** Sharpness slider; en "Sharpness". */
  readonly sharpness: string;
  /** Value of the Picture row with nothing adjusted; en "Original picture". */
  readonly resetPicture: string;
  /** Value of the Picture row while any adjustment is on. */
  readonly pictureAdjusted: string;
  /** Reset button; en "Reset". */
  readonly reset: string;
}

/** Row labels of the stats panel (its chunk holds the defaults by language). */
export interface StatsStrings {
  /** Row: playback status; en "Status". */
  readonly status: string;
  /** Row: format and engine; en "Format". */
  readonly format: string;
  /** Row: backend; en "Backend". */
  readonly backend: string;
  /** Row: picture size; en "Resolution". */
  readonly resolution: string;
  /** Row: codecs; en "Codec". */
  readonly codec: string;
  /** Row: the playing quality; en "Quality". */
  readonly quality: string;
  /** Row: bandwidth estimate; en "Bandwidth". */
  readonly bandwidth: string;
  /** Suffix of a bandwidth that is the engine's estimate, not a measurement. */
  readonly estimated: string;
  /** Row: seconds buffered ahead; en "Buffer". */
  readonly buffer: string;
  /** Row: live latency; en "Latency". */
  readonly latency: string;
  /** Row: time to first frame; en "TTFF". */
  readonly ttff: string;
  /** Row: rebuffer count and time; en "Rebuffers". */
  readonly rebuffers: string;
  /** Row: quality switches; en "Switches". */
  readonly switches: string;
  /** Row: dropped frames; en "Dropped". */
  readonly dropped: string;
  /** Row: error count; en "Errors". */
  readonly errors: string;
  /** "last: {label}" */
  readonly lastError: string;
  /** The route row before any decision; en "no decision yet". */
  readonly noDecision: string;
}

/**
 * Every text of the controls (labels, aria-labels, tooltips, screen-reader announcements), in one
 * language. Write one per language and give it with provideStrings.
 */
export interface UiStrings {
  /** BCP 47 language of this table (`en`, `zh-CN`): on-demand pages pick their texts by it. */
  readonly locale: string;
  /** Play button label and tooltip; en "Play". */
  readonly play: string;
  /** Pause button label and tooltip; en "Pause". */
  readonly pause: string;
  /** Mute button label; en "Mute". */
  readonly mute: string;
  /** Unmute button label; en "Unmute". */
  readonly unmute: string;
  /** Volume slider name; en "Volume". */
  readonly volume: string;
  /** Time slider name; en "Seek". */
  readonly seek: string;
  /** Time slider value text, "{current} of {duration}" (spoken times). */
  readonly timeOf: string;
  /** Live badge at the live edge; en "Live". */
  readonly live: string;
  /** Live badge behind the edge (DVR); en "Behind live". */
  readonly behindLive: string;
  /** Captions button and menu; en "Captions". */
  readonly captions: string;
  /** The captions menu's off item; en "Off". */
  readonly captionsOff: string;
  /** Settings button and menu; en "Settings". */
  readonly settings: string;
  /** Quality button and menu; en "Quality". */
  readonly quality: string;
  /** The quality menu's automatic item; en "Auto". */
  readonly qualityAuto: string;
  /** The automatic item with the playing quality, "Auto ({label})". */
  readonly qualityAutoActive: string;
  /** Speed button and menu; en "Speed". */
  readonly speed: string;
  /** The 1x item of the speed menu; en "Normal". */
  readonly speedNormal: string;
  /** Fullscreen button, entering; en "Fullscreen". */
  readonly fullscreen: string;
  /** Fullscreen button, leaving; en "Exit fullscreen". */
  readonly exitFullscreen: string;
  /** Picture-in-picture button, entering; en "Picture in picture". */
  readonly pip: string;
  /** Picture-in-picture button, leaving; en "Exit picture in picture". */
  readonly exitPip: string;
  /** Theater button, entering; en "Theater mode". */
  readonly theater: string;
  /** Theater button, leaving; en "Default view". */
  readonly exitTheater: string;
  /** Cast button, not casting; en "Cast". */
  readonly cast: string;
  /** Cast button while casting; en "Casting". */
  readonly stopCast: string;
  /** AirPlay button; en "AirPlay". */
  readonly airplay: string;
  /** The mini window's close button; en "Close mini player". */
  readonly closeMini: string;
  /**
   * Picture page (zoom and filters, SPEC §12). Its default texts load with the settings menu's
   * level-two chunk; a host table may override them here.
   */
  readonly picture?: Partial<PictureStrings>;
  /**
   * Danmaku settings page: its default texts load with that page; a host table may override them
   * here.
   */
  readonly danmakuPage?: Partial<DanmakuStrings>;
  /**
   * Stats panel row labels: their defaults load with the panel; a host table may override them
   * here.
   */
  readonly stats?: Partial<StatsStrings>;
  /** Spoken durations (aria-valuetext): "{n} hour" / "{n} hours", ...; joined by spaces. */
  readonly hour: string;
  /** Spoken duration, plural; en "{n} hours". */
  readonly hours: string;
  /** Spoken duration, singular; en "{n} minute". */
  readonly minute: string;
  /** Spoken duration, plural; en "{n} minutes". */
  readonly minutes: string;
  /** Spoken duration, singular; en "{n} second". */
  readonly second: string;
  /** Spoken duration, plural; en "{n} seconds". */
  readonly seconds: string;
  /** Spoken time when the duration is not known; en "unknown". */
  readonly timeUnknown: string;
  /** Audio track menu; en "Audio". */
  readonly audio: string;
  // Caption display settings (CVAA).
  /** Caption style page: size row; en "Caption size". */
  readonly captionSize: string;
  /** Caption style page: text colour row; en "Caption color". */
  readonly captionColor: string;
  /** Caption style page: background row; en "Caption background". */
  readonly captionBackground: string;
  /** Caption style page: window row; en "Caption window". */
  readonly captionWindow: string;
  /** Caption style page: edge row; en "Caption edge". */
  readonly captionEdge: string;
  /** Caption style page: font row; en "Caption font". */
  readonly captionFont: string;
  /** Caption style value: the default; en "Default". */
  readonly styleDefault: string;
  /** Caption colour value; en "White". */
  readonly colorWhite: string;
  /** Caption colour value; en "Yellow". */
  readonly colorYellow: string;
  /** Caption colour value; en "Cyan". */
  readonly colorCyan: string;
  /** Caption colour value; en "Green". */
  readonly colorGreen: string;
  /** Caption background value; en "None". */
  readonly backgroundNone: string;
  /** Caption background value; en "Semi-transparent". */
  readonly backgroundSemi: string;
  /** Caption background value; en "Opaque". */
  readonly backgroundOpaque: string;
  /** Caption edge value; en "None". */
  readonly edgeNone: string;
  /** Caption edge value; en "Drop shadow". */
  readonly edgeShadow: string;
  /** Caption edge value; en "Outline". */
  readonly edgeOutline: string;
  /** Caption edge value; en "Raised". */
  readonly edgeRaised: string;
  /** Caption edge value; en "Depressed". */
  readonly edgeDepressed: string;
  /** Caption font value; en "Serif". */
  readonly fontSerif: string;
  /** Caption font value; en "Monospace". */
  readonly fontMonospace: string;
  /** Caption font value; en "Casual". */
  readonly fontCasual: string;
  /** Settings row that opens the caption style page; en "Caption style". */
  readonly captionStyle: string;
  /** Sample text in the caption style preview. */
  readonly captionPreview: string;
  /** Back to the previous menu page; en "Back". */
  readonly back: string;
  /** Settings row that opens the stats panel; en "Stats for nerds". */
  readonly statsForNerds: string;
  /** Stats panel: copy button; en "Copy as JSON". */
  readonly copy: string;
  /** Close button of panels; en "Close". */
  readonly close: string;
  /** "Back {n} seconds" */
  readonly seekBack: string;
  /** Seek button forwards, "Forward {n} seconds". */
  readonly seekForward: string;
  /** Live badge action behind the edge; en "Back to live". */
  readonly backToLive: string;
  /** Error card title; en "This video can’t be played". */
  readonly errorTitle: string;
  /** Error card retry button; en "Retry". */
  readonly retry: string;
  /** Stats panel section; en "Playback". */
  readonly statsPlayback: string;
  /** Stats panel section; en "Network". */
  readonly statsNetwork: string;
  /** Stats panel section; en "Quality". */
  readonly statsQuality: string;
  /** Spinner name; en "Loading". */
  readonly loading: string;
  /** The player region's name; en "Video player". */
  readonly player: string;
  /** Stats panel name; en "Playback statistics". */
  readonly statistics: string;
  // Announcer (aria-live) messages.
  /** Announced on play; en "Playing". */
  readonly announcePlaying: string;
  /** Announced on pause; en "Paused". */
  readonly announcePaused: string;
  /** Announced on mute; en "Muted". */
  readonly announceMuted: string;
  /** Announced on unmute; en "Unmuted". */
  readonly announceUnmuted: string;
  /** "Volume {n}%" */
  readonly announceVolume: string;
  /** "Captions on: {label}" */
  readonly announceCaptionsOn: string;
  /** Announced when captions go off; en "Captions off". */
  readonly announceCaptionsOff: string;
  /** "Quality {label}" */
  readonly announceQuality: string;
  /** "Speed {n}x" */
  readonly announceSpeed: string;
  /** "Playback error: {label}" */
  readonly announceError: string;
  /** Announced on entering fullscreen; en "Fullscreen". */
  readonly announceFullscreen: string;
  /** Announced on leaving fullscreen; en "Exited fullscreen". */
  readonly announceExitFullscreen: string;
}

/** The English texts (the fallback). */
export const STRINGS_EN: UiStrings = {
  locale: 'en',
  hour: '{n} hour',
  hours: '{n} hours',
  minute: '{n} minute',
  minutes: '{n} minutes',
  second: '{n} second',
  seconds: '{n} seconds',
  timeUnknown: 'unknown',
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

/** The Chinese texts (`zh*`). */
export const STRINGS_ZH: UiStrings = {
  locale: 'zh-CN',
  hour: '{n} 小时',
  hours: '{n} 小时',
  minute: '{n} 分钟',
  minutes: '{n} 分钟',
  second: '{n} 秒',
  seconds: '{n} 秒',
  timeUnknown: '未知',
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

/** Strings for every primitive under `root` (default: by language, see the top of this file). */
export function provideStrings(root: Node, strings: UiStrings): void {
  tables.set(root, strings);
}

/** The UI language at `from`: the nearest `lang` attribute (across shadow roots), else the browser's. */
export function uiLanguage(from: Node): string {
  let node: Node | null = from;
  while (node !== null) {
    const lang = node instanceof Element ? node.getAttribute('lang') : null;
    if (lang !== null && lang !== '') return lang;
    node = node.parentNode ?? ((node as { host?: Node }).host ?? null);
  }
  return (globalThis.navigator as { language?: string } | undefined)?.language ?? 'en';
}

const isZh = (lang: string): boolean => /^zh\b/i.test(lang);

/**
 * The texts for `from`: a table provided on it or an ancestor, else the built-in one for its UI
 * language.
 */
export function findStrings(from: Node): UiStrings {
  let node: Node | null = from;
  while (node !== null) {
    const table = tables.get(node);
    if (table !== undefined) return table;
    node = node.parentNode ?? ((node as { host?: Node }).host ?? null);
  }
  return isZh(uiLanguage(from)) ? STRINGS_ZH : STRINGS_EN;
}

/** `format('Volume {n}%', { n: 50 })` */
export const fill = (template: string, values: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (values[k] === undefined ? m : String(values[k])));
