# ADR-016：伴随模式（companion mode）契约

- 状态：已采纳（2026-11-11）。负责人对第 0 停汇报回复「那你就继续做呗」，按此执行：各冲突取本文写的**建议项**，见文末「批准记录」。如有不同意见，以负责人后续指示为准，改本 ADR
- 日期：2026-11-11
- 关联：
  - 需求：`docs/design/COMPANION.md`。
  - 实测：RESEARCH §1「伴随模式第 0 停：Document PiP 实测」。
  - SPEC §15「伴随模式」；ADR-007 §5（presentation 状态机、Document PiP）。
  - ADR-011 批次 3（偏好）；ADR-013 §4（按需块）；ADR-015（公开站冻结）。

## 背景

负责人 2026-10-29 看 demo 时提出：工作时播放，不打扰主任务。播放器放进一个置顶小窗，画面可调暗，控件平时不出现，也可以只留一条音频条。

现有的 `docpip` 模式已经把整个播放器根节点搬进 Document PiP 窗口，并复制样式表。ui-core 已有暗化层（`brightness` 0.2–1，不透明度 `1 - brightness`，上限 0.8），还有控件自动隐藏（`idleMs`）。伴随模式就建在这两者上。

浏览器做不到窗口透明和点击穿透，那是桌面壳的事，不在本 ADR 范围内。

本 ADR 以负责人的契约初稿为底（全文见 COMPANION.md §4）。第 0 停在本机 Chromium 156 上实测了六项，有界面和无头各一遍；真 Edge 没有连上。凡是与初稿冲突、或初稿没有覆盖的地方，列在「与初稿的冲突」，每条给出选项和建议，待负责人定。下面「决定」里引用这些条目的地方，写的都是**建议**取值。

## 决定（提议）

### 1. 模式与状态

- 不新增 `PresentationMode`。伴随 = `docpip` + 一份伴随状态。SPEC §15 的状态图不变。
- 宿主开启伴随后，`docpip` 只有伴随这一种含义：`toggle-pip`、`toggle-companion`、`request-presentation { mode: 'docpip' }` 进的都是伴随小窗。不再有「开了伴随又进普通 docpip」的组合。
- 状态放在 `PresentationSnapshot.companion`，store 里的路径是 `presentation.companion`：

```ts
interface CompanionState {
  /** 宿主开启了伴随，且这里有 Document PiP（capabilities.docpip !== false，含「不在 iframe 里」）。 */
  readonly supported: boolean;
  /** 现在在伴随小窗里（mode === 'docpip'）。 */
  readonly active: boolean;
  readonly dim: number;                 // 0..0.8
  readonly size: 's' | 'm' | 'l';
  readonly audioOnly: boolean;
  /** dim、size、audioOnly 是否记进偏好（CompanionOptions.remember）；偏好插件读它。 */
  readonly remember: boolean;
}
```

- 宿主没开伴随时，`companion` 照样存在：`supported: false`、`active: false`，其余字段是默认值。UI 和测试据此判断，不用判空。

### 2. 选项与动作

- 宿主选项是 `PresentationPluginOptions.companion?: boolean | CompanionOptions`。`createPlayer` 的 `presentation` 选项原样透传。
- `CompanionOptions` 照初稿，有两处改动：
  - `size` 的高度见冲突 1、2；
  - 新增 `returnButton`，见冲突 4。
- 新增两个动作，加进 `PresentationActionMap`：
  - `'toggle-companion': Record<string, never>`：不在伴随里就进，在就退。
  - `'companion-set': { readonly dim?: number; readonly size?: 's' | 'm' | 'l'; readonly audioOnly?: boolean }`：
    - 不在小窗里时，只改状态（和偏好）。
    - 在小窗里时立即生效。改尺寸或切音频条要调 `resizeTo`，这一步受冲突 2 的限制。
- `toggle-pip`：伴随 `supported` 时进伴随小窗；否则照旧（`preferDocumentPip` / 视频 PiP 的既有规则）。
- 伴随打开时，宿主的 `docPipSize` 不起作用，用的是 `size` 的档位。

### 3. 暗化

- 复用 `<otter-gesture>` 里的 `.dim`。不加第二层，不碰 surface 的滤镜链（`picture` 插件的「亮度」滤镜是另一回事，见 GLOSSARY）。
- 小窗内不透明度 = `min(0.8, max(1 - brightness, dim))`；不在小窗里时 = `min(0.8, 1 - brightness)`，与现在相同。伴随不写 `brightness`。
- 只暗化画面：
  - 代码事实：
    - 叠加层容器插在 `<video>` 之后、`<otter-gesture>` 之前（`surface/src/overlay-layer.ts`）。
    - 各叠加层的根节点带 `z-index`：弹幕 100、字幕 200、ASS 210、水印 400、广告 500。
    - 控制栏和顶栏在皮肤里是 `z-index` 2 / 3。
    - `<otter-gesture>` 是 `z-index: auto`。
    - 播放器根节点有 `container-type: inline-size`，即 layout containment，自成层叠上下文。
  - 所以 `.dim` 盖住的只有 `<video>` 和 WebCodecs 画布（`data-otter-frames`，也插在 `<video>` 之后）。这一点是读代码得出的，第 1 停用 `elementsFromPoint` 和像素核对补测试。

### 4. 小窗内的控件

- 伴随打开时，控件可见只由两件事决定：
  - 指针在小窗里：`pointerenter` / `pointerleave` 发生在被搬进小窗的根节点上；
  - 焦点在控件上：`focusin` / `focusout`。
- 播放开始、暂停、媒体事件、`show-controls` 的定时都不让它显示；离开即隐藏，不等 `idleMs`。
- 退出伴随后，回到 `idleMs` 规则。
- 精简控制栏：播放 / 暂停、静音、进度与时间、设置、回页面。其余按钮在小窗里由伴随样式隐藏，DOM 不动，退出后原样。
- 菜单打开时（`menu !== null`）控件保持可见，避免设置页在指针移出时消失。这一条初稿没有写，建议照此处理。

### 5. 纯音频条

- 画面层（`<video>`、`data-otter-frames`、海报）`display: none`。条上常显：播放 / 暂停、静音、进度与时间、回页面。
- 窗口高度按冲突 1、2 定，宽度用当前尺寸档的宽度。
- 不停视频解码。第 0 停实测：三条路径隐藏画面后都照常解码（RESEARCH §1 第 5 项）。

### 6. quiet

- 进入时记下弹幕开关和当前字幕轨，然后关掉；退出时恢复进入前的状态。
- 偏好插件现在是在 `set-text-track`、`set-danmaku` 的处理器里写偏好（`preferences/src/index.ts` 约 242、250 行）。quiet 如果派发这两个动作，就会写偏好。处理办法见冲突 9。
- 用户在小窗里手动打开的，退出时一并恢复到进入前；这一段时间的改动也不写偏好。

### 7. 关窗

- 浏览器关掉窗口（`pagehide`）时按 `onClose` 处理：
  - `'pause'`：播放器回到页面后暂停；
  - `'continue'`：回到页面继续播。
- 小窗内自己的「回页面」按钮：退出小窗、继续播放，并尽力聚焦原标签页（具体办法第 2 停实测，失败不报错）。
- 能否区分「关闭」和浏览器自带的「返回标签页」，见冲突 4。

### 8. 偏好

- `Preferences` 加字段：

```ts
readonly companion?: { readonly dim?: number; readonly size?: 's' | 'm' | 'l'; readonly audioOnly?: boolean };
```

- `sanitize` 的规则：
  - `dim` 夹到 0–0.8；
  - `size` 只认三个值；
  - `audioOnly` 只认布尔值；
  - 其余丢掉。
- `remember: false` 时不读也不写。不存窗口位置；浏览器自己会记，见冲突 3。

### 9. 设置菜单

- 二级页 `companion`，中文「小窗」（初稿）。英文建议 **Floating player**；中英文都与现有文案撞词，见冲突 13，待负责人定。
- 页面内容：暗化五档 0 / 20 / 40 / 60 / 80 %、尺寸三档、纯音频条开关。
- 只在 `presentation.companion.supported` 时出现，页面内和小窗内都能调。
- 这一页放进设置菜单已有的二级按需块（`settings-level.ts`），不进首屏。

### 10. 退化

- `supported: false` 时：
  - `toggle-pip` 走既有规则（视频 PiP，只有画面）；
  - 设置页不出现；
  - `toggle-companion` 发 `presentation-denied`（reason `unsupported`），这是既有的拒绝事件，不是错误事件。
- iframe 内 `capabilities.docpip` 本来就是 false（`win.top === win` 才算），自然退化。

### 11. 媒体键

现有的 MediaSession 绑定（`bindMediaSession`）是绑在 opener 的 `navigator.mediaSession` 上的。`<video>` 被搬进 PiP 文档后，媒体键是否还会路由到这里，第 0 停没有量。Playwright 发不出系统媒体键。第 1 停在有界面浏览器上实测；不成立的话，在 PiP 文档的 `navigator.mediaSession` 上另绑一份。

### 12. 适用范围（逐个 preset）

| preset | 构造方式 | 伴随 |
|---|---|---|
| vod | `createPlayer` | 提供 |
| live | `createPlayer` | 提供 |
| lowlatency | `createPlayer` | 提供 |
| ott-drm | `createPlayer` | 提供 |
| danmaku | `createPlayer` | 提供 |
| tv | `createPlayer`（`...options` 透传） | **不提供**：电视不做伴随（明确不做）。tv 必须显式关掉 `presentation.companion`，否则宿主经透传能打开它，见冲突 10 |
| basic | 自组装，没有 presentation 插件（只有全屏） | 不提供 |
| shorts | 经 basic | 不提供 |
| surveillance | 自组装 | 不提供 |
| background | 自组装，没有 UI | 不提供（初稿没有列出，补上） |

### 13. 命名

- 公开术语用 companion。
- 内部文件 `presentation/src/companions.ts` 改名为 `helpers.ts`。`PresentationPlugin.ready`、`plugin.ts` 文件头注释里的 companions 改成 helpers。
- 不改任何公开标识符。GLOSSARY 加两个词（见该文件）。

### 14. 体积

- 首屏门禁 30 KB 不动。首屏只加 ui-core 里暗化公式和读状态的几行。
- 伴随的窗口管理、quiet、关窗、控件可见性、样式，放进 presentation 的按需块 `companion.js`，进入伴随时加载，与 `docpip.js` 同样处理。
- 样式只注入 PiP 文档。退出时随窗口一起销毁，页面文档里不留节点和样式。
- 按需块在 `.size-limit.js` 里单列，暂定 ≤ 3 KB gzip；超了先报数。
- 当前首屏余量见第 0 停汇报。

## 与初稿的冲突（第 0 停实测，待负责人定）

数字均为本机 Chromium 156：「有界面」指 Chrome for Testing，「无头」指 `desktop-chrome`。真 Edge 一律未测（冲突 8）。

1. **240 × 44 的音频条开不出来。**
   - 实测：`requestWindow` 的内容区最小 240×52；请求 240×44 或 100×30，都得到 240×52。
   - 选项：
     - (a) 条高定 52；
     - (b) 条高按冲突 2 定成 66，进入和切换一致；
     - (c) 留 44 px 的控件行，上下补白到 52 / 66。
   - 建议 (b)。
2. **打开后改尺寸要用户激活；改的是 outer；最低到不了 52。**
   - 实测：
     - `resizeTo` / `resizeBy` 没有瞬时激活时抛 `NotAllowedError`，有激活时成功并消耗激活；
     - `resizeTo` 的宽高是 outer，有界面时标题栏 34 px；
     - 已打开的窗口最低只能缩到内容区 66 px（outer 100）。
   - 影响：
     - `companion-set` 在手势里（设置页点击）能立即改窗口；
     - 从宿主代码（无手势）调用时，窗口尺寸改不了，只能改布局；
     - 在已开的小窗里切到音频条，最低是 66 px。
   - 选项：
     - (a) 无手势时只改状态和布局，窗口尺寸等下次打开再用，并发一次 `presentation-denied`（reason `noUserGesture`）；
     - (b) 无手势时什么都不改。
   - 建议 (a)。条高与冲突 1 一起定。
   - 换算：用 `outerHeight - innerHeight` 算标题栏高度，不写死 34。
3. **浏览器自己会记小窗的位置和尺寸。**
   - 实测：上一次请求的尺寸与这次相同，就恢复上次窗口的位置和尺寸（实测的是脚本 `resizeTo` 改过之后；用户拖动没法用脚本测），传入的尺寸被忽略。尺寸不同就用新尺寸。传 `preferInitialWindowPlacement: true`（Chromium 156 认这个成员）则每次都按请求的尺寸、默认位置。
   - 初稿「不存窗口位置」指 Otter 自己不存，这一条仍成立；但浏览器会存。
   - 选项：
     - (a) 不传 `preferInitialWindowPlacement`：用户拖过的尺寸和位置在同一档位下保留，换档时自然用新档；
     - (b) 传 true：每次都是档位尺寸、默认位置。
   - 建议 (a)。
   - 风险：用户拖过之后，同一档位就不再是 240 / 320 / 440。设置页显示的档位与窗口实际大小可能不一致。
4. **`pagehide` 区分不了「关闭」和「返回标签页」。**
   - 实测：opener 调 `close()`、窗口自己 `close()`、Playwright 关窗，三种情况事件完全相同：`blur`、`pagehide`（`persisted: false`）、`visibilitychange`、`unload`；opener 上没有任何事件。
   - 浏览器标题栏里的「返回标签页」按钮点不到，没有量；按事件模型推测它也是同一个 `pagehide`（假设）。
   - 影响：`onClose: 'pause'` 时，用户点浏览器自带的「返回标签页」也会暂停，和这个按钮的字面意思相反。
   - 选项：
     - (a) `requestWindow` 传 `disallowReturnToOpener: true`，去掉浏览器的按钮，回页面只剩小窗内我们自己的按钮。Chromium 156 读这个成员；按钮是否真的消失，没有目视核实，第 1 停在有界面浏览器上看。
     - (b) 不传，接受浏览器的按钮也按 `onClose` 处理。
     - (c) 默认 `onClose` 改成 `'continue'`。
   - 建议 (a)，并在 `CompanionOptions` 加 `returnButton?: 'player' | 'both'`（默认 `'player'`，即传 `disallowReturnToOpener`）。是否加这个选项请负责人定，也可以不开放、固定 (a)。
5. **真正停掉视频解码（明确不做，只量）。**
   - 实测：隐藏画面后，三条路径的解码帧数不变（MSE 25、native 30、WebCodecs 30 帧/s）。
   - 本期不做，没有冲突，只是记录。
6. **desktop-firefox 很可能报 `supported: true`。**
   - RESEARCH §1（M3）记录过：Playwright 的 Firefox 构建提供 `documentPictureInPicture`，无头也能真正进入。正式版 Firefox 没有。能力只靠特性探测（SPEC §5.1，不许 UA 判断），所以 desktop-firefox 上伴随的 `supported` 会是 true，与验收第 6 条「desktop-firefox 上 `supported` 为 false」冲突。
   - 第 0 停没有复测成：本机 Playwright Firefox 157 起不来（RESEARCH §1 末条）。这个构建里有 `dom.documentpip.enabled`，默认值不明，待 CI（Ubuntu）上的 desktop-firefox 证实。
   - emulated-android 同理会报 `supported: true`（Chromium 仿真有 Document PiP）。验收第 8 条已把它定为只记录不判定，不冲突。
   - 选项：
     - (a) 验收第 6 条改为：desktop-firefox 记录探测结果；为 true 时跑伴随用例，只记录不判定，与 emulated-android 同样处理；
     - (b) desktop-firefox 上用 init script 删掉 `documentPictureInPicture`，判退化路径（像 `emulated-iphone` 的 `iphoneShape`）；
     - (c) 两者都做，分两个用例。
   - 建议 (c)。
7. **「省 CPU / GPU」能不能写。**
   - 实测（有界面，本机 Mac，三次）：隐藏画面后，解码照常，但整个浏览器的 CPU 合计下降：MSE 约 35 → 17–20 %，native 约 37–38 → 18–22 %，WebCodecs 约 46–51 → 33–36 %（单核 %）。降下来的是浏览器进程和 GPU 进程（合成与上屏），渲染进程不变。
   - 只有一台 Mac，Windows 真 GPU 的 Edge 没有量，所以本 ADR 和 COMPANION.md **都不写**这个说法。
   - 选项：
     - (a) 等真 Edge 复测，结论一致再写，写成「隐藏画面后合成与上屏的 CPU 下降，解码不变」；
     - (b) 本期一律不写。
   - 建议 (a)。
8. **真 Edge 没有量。**
   - 工作副本是新 clone 的，没有 `tmp/env`（`OTTER_WIN_TOKEN`），也没有 M6 用的实例客户端 `tmp/win.py`、`tmp/tools/agrt_token.py`。按要求没有另建实例。
   - 请负责人提供 token 与客户端（或说明取法），第 1 停开始前补量六项。
9. **quiet 不写偏好，需要偏好插件配合。**
   - 偏好插件在 `set-text-track`、`set-danmaku` 的处理器里写偏好。quiet 通过这两个动作关字幕和弹幕，就一定会写。
   - 选项：
     - (a) 偏好插件读 `presentation.companion`：`active` 且 quiet 时，不写 textLanguage 和 danmaku。偏好插件只依赖状态形状，不依赖 presentation 包的代码；
     - (b) 给这两个动作的负载加 `transient?: true`。这会改公开的 `MediaActionMap` / danmaku 动作类型；
     - (c) 伴随退出时把偏好写回进入前的值。写过一次，不满足「不写偏好」。
   - 建议 (a)。
10. **tv 也经 `createPlayer`。**
    - 初稿说「经 `createPlayer` 的 preset」，但 tv 也是 `createPlayer` 组装的，而且 `...options` 原样透传 `presentation`。
    - 选项：
      - (a) `createTvPlayer` 固定 `presentation.companion: false`，覆盖宿主传入；
      - (b) 只在类型上去掉，运行时不管。
    - 建议 (a)。background 初稿没有列出，补进「不提供」（第 12 节）。
11. **无头 `desktop-chrome` 判不了窗口几何。**
    - 无头 shell 里 PiP 窗口是普通页面，尺寸随 viewport（或 800×600），`requestWindow` 的宽高不生效，位置恒为 (0, 0)。
    - 影响：三档尺寸、音频条高度、窗口截图的「样子」，CI 判定不了。
    - 建议：
      - CI 的 desktop-chrome 判逻辑：请求的尺寸、`resizeTo` 的调用与报错、布局、暗化的计算值、像素亮度比（PiP 页面可以截图）；
      - 尺寸和目视材料用本机有界面 Chromium 加真 Edge。
    - 验收第 8 条「伴随功能只在 desktop-chrome 和真 Edge 上判定」照旧，几何项只在真 Edge 判。
12. **切走标签页自动进小窗（明确不做，只量）。**
    - 实测：Chromium 156 接受 `setActionHandler('enterpictureinpicture')`，但在新 profile、有声播放、真正切换标签页的条件下，处理器没有被调用，加功能开关也一样。`automatic-picture-in-picture` 不是合法的权限名。需要什么条件没有查到。
    - 本期不做，只是记录。
13. **「小窗」与英文名和现有文案撞词。**
    - 现有 UI 文案里，「小窗」/ mini player 已经指页面小窗（`mini` 模式）。关闭按钮是 `closeMini`：中文「关闭小窗」，英文 "Close mini player"（`ui-core/src/strings.ts`）。
    - 设置页也叫「小窗」的话，同一个播放器里「小窗」会指两样东西。英文要是用 Mini player，也一样撞。
    - 选项：
      - (a) 设置页中文「小窗」不变，页面小窗的按钮改叫「关闭页内小窗」/ "Close in-page player"。这是改文案，不改标识符；
      - (b) 设置页另起名，如「悬浮窗」/ "Floating player"，页面小窗的文案不动；
      - (c) 英文直接用 "Companion"。
    - 建议 (b)。GLOSSARY 先把「伴随模式 / companion」作为术语加上，设置页的显示名列进「改名候选」。

## 理由

- 建在 `docpip` 上：
  - 状态机不变，进出小窗不断播的保证（ADR-007 §5）原样继承；
  - 伴随只是「小窗里的另一种样子」，不是一种新的窗口。
- 暗化复用现有一层：读代码确认它只盖画面，不用再加一层、调层叠。
- 按需块：伴随只有少数用户、少数浏览器用得到，首屏余量很小。

## 代价

- 伴随依赖 Document PiP，只有 Chromium 系桌面浏览器有。Firefox 正式版、Safari、手机上都只退化成视频 PiP。
- 浏览器会记窗口的位置和尺寸，档位与实际窗口可能不一致（冲突 3）。
- 无手势的 `companion-set` 改不了窗口尺寸（冲突 2）。

## 后果

- 批准后按 COMPANION.md §5 分三停实现。
- 每一停照 AGENT §5 汇报，第 1 停开始前补真 Edge 的六项（冲突 8）。

## 批准记录（2026-11-11）

负责人回复「那你就继续做呗」后，按建议项执行：

| 冲突 | 采用 | 落在哪一停 |
|---|---|---|
| 1、2 | 音频条内容区高 66 px（进入与切换一致）；无手势的 `companion-set` 只改状态与布局，窗口尺寸不变，发 `presentation-denied`（`noUserGesture`）；标题栏高度按 `outerHeight - innerHeight` 算 | 尺寸：第 1 停；音频条：第 2 停 |
| 3 | 不传 `preferInitialWindowPlacement`，浏览器记住的位置和尺寸照用 | 第 1 停 |
| 4 | `requestWindow` 固定传 `disallowReturnToOpener: true`；**不开放** `returnButton` 选项（以后需要再加） | 第 2 停（与 `onClose` 一起） |
| 6 | desktop-firefox 两个用例：探测结果只记录不判定；删掉 `documentPictureInPicture` 后判退化路径 | 第 3 停 |
| 7 | 文档不写「省 CPU / GPU」，等真 Edge 复测 | — |
| 8 | 仍缺 token 与客户端，真 Edge 待负责人提供 | — |
| 9 | 偏好插件读 `presentation.companion`：`active` 且 quiet 时不写 textLanguage 与 danmaku | 第 2 停 |
| 10 | `createTvPlayer` 固定 `presentation.companion: false` | 第 1 停 |
| 13 | 设置页显示名「悬浮窗」/ "Floating player"，页面小窗文案不动 | 第 2 停 |

另外，第 1 停加了 `CompanionState.remember`（偏好插件据此决定读写）。
