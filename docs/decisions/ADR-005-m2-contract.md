# ADR-005：M2 契约（ABR 规则栈、CMCD、错误恢复、字幕、InputController、无障碍）

- 状态：已采纳
- 日期：2026-10-16
- 关联：`SPEC.md` §7、§13.1、§14、§21；`REUSE.md` §3、§4；ADR-003、ADR-004

## 背景

M2 要做引擎侧的 ABR 规则叠加、CMCD 和错误恢复，以及渲染侧的完整 UI 原语、默认皮肤、字幕、InputController 和无障碍。M2 期间所有播放仍然经由 hls.js / Shaka / mpegts.js 适配器（自研管线在 M3）。因此必须先决定：我们的 ABR 规则栈和 CMCD 在哪里生效，字幕由谁渲染，以及与适配器怎样分工。

## 决策

### 1. ABR：规则栈在 `pipeline`，M2 即驱动 hls.js 与 Shaka

- `pipeline` 新增引擎无关、DOM 无关的 ABR 规则栈：
  - `AbrRule { id, weight, decide(ctx): AbrVote | null }`；
  - `AbrVote { level?, maxLevel?, minLevel?, priority, reason }`；
  - `createAbrController({ rules, estimator })`：先应用限制（`maxLevel` 取最小、`minLevel` 取最大），再对 `level` 按 `weight × priority` 加权投票，同票取较低档；输出 `{ level, reason, votes }`，可解释。
- 规则：
  - `throughput`：dash.js `ThroughputRule`（L3）；
  - `bola`：dash.js `BolaRule`（L3），默认在缓冲 ≥ 稳态阈值后生效；
  - `insufficientBuffer`：dash.js `InsufficientBufferRule`（L3），只给 `maxLevel`；
  - `serverHint`：接口和空实现预留，读 CMSD / Content Steering 的提示，M3 之后再实现。
- 带宽估计：hls.js `EwmaBandWidthEstimator` + `EWMA`（L3），快 / 慢两条 EWMA 取小值。
- 接入：
  - hls.js：自定义 `abrController` 类，实现 hls.js `AbrComponentAPI` 的子集；
  - Shaka：`abrFactory`，实现 `shaka.extern.AbrManager`。
  
  两者都把规则栈的决策映射为各自的档位选择，并把投票理由经 `quality-change.reason` 上报 QoE。mpegts.js 只有单档，不接 ABR。
- 关闭开关：`createHlsFormat({ abr: 'engine' })` / `createDashFormat({ abr: 'engine' })` 退回引擎自带 ABR，用于对比和应急。

### 2. CMCD：`@svta/cml-cmcd`（L1），三个引擎统一

- 依赖从 REUSE 原写的 `@svta/common-media-library` 改为同一 SVTA monorepo 拆分出来的 `@svta/cml-cmcd`（2.8.2，Apache-2.0；对等依赖 `@svta/cml-structured-field-values`、`@svta/cml-utils`）。原因是伞包已经停在 0.18.1（2025-10）。REUSE §3 同步修改。
- `media` 新增 `CmcdReporter`：`sid`（会话 UUID）、`cid`、`ot` / `br` / `bl` / `d` / `mtp` / `su` / `sf` / `st` 等由会话状态生成，按 `query` 或 `headers` 模式编码。默认关闭，`createMediaPlugin({ cmcd: { enabled, mode, contentId } })` 打开。
- 三个引擎都通过请求钩子注入，键集合一致：
  - hls.js：`xhrSetup` / `fetchSetup`；
  - Shaka：`registerRequestFilter`；
  - mpegts.js：FLV / TS 直播通常只有一个长连接请求，创建播放器时把 CMCD 写进 URL query（query 模式）或 `headers`（headers 模式）一次；点播分段请求按同样方式逐次写入。
- hls.js 自带的 CMCD 控制器保持关闭，避免重复上报。
- CMCD 库只在打开 CMCD 时动态加载（`import()`），不进首屏。

### 3. 错误恢复与降级链

- 引擎内恢复，按错误类型逐层放大：
  1. 网络错误：按 `shouldRetry` 谓词指数退避重试；
  2. 媒体错误：hls.js `recoverMediaError` / `swapAudioCodec`，Shaka 重新 `load` 到当前位置；
  3. 同一 backend 内重建引擎；
  4. 走 ADR-003 的降级链换 backend。
  
  每一步都发 `error` QoE 事件，`fallback` 字段写明剩余路径。
- 新增 `RecoveryPolicy`：每类错误的重试次数、窗口和退避，默认网络 3 次（1 s → 2 s → 4 s），媒体 1 次。（2026-10-19 实施补充：重试是"同一 backend 重建"，计数在连续正常播放 30 s 后清零；`noRetry` 列出重建修不好的错误（如 `mediaSrcNotSupported`、`manifestIncompatibleCodecsError`），这类错误直接走降级链；加载阶段只有网络错误重试，其余照 ADR-003 立即降级。）
- 卡顿恢复：`stalled` 持续超过 `stallTimeoutMs`（默认 8 s）而且有缓冲时，先 nudge（`currentTime += 0.1`），再按媒体错误处理。M3 的 LiveController 会接管直播场景。（2026-10-19 修订：起播后播放头还没动过时用 `startupStallMs`（1.5 s）。CI 实验证实 WebKit MSE 在音频早于首个视频帧时会停在首帧，nudge 立即解除，8 s 太慢；见 RESEARCH §1。）
- 「每个 fatal 错误必须附降级路径」（AGENT §4）：`error.fallback` 为空时，表示降级链已耗尽，store 的 `status` 为 `error`，UI 显示错误态。

### 4. 字幕（`text`）

- 包内分三层：
  - **cue 来源**：外挂 VTT / SRT；引擎带内字幕（hls.js 的 `CUES_PARSED`、Shaka 的 text displayer、608 的 userdata）；IMSC1 / TTML。
  - **统一 cue 模型** `TextCue`：时间、文本或 IMSC 的 ISD、VTT 布局属性。
  - **渲染器**：自定义 `CueRenderer` 或原生 `TextTrack`。
- 解析：
  - WebVTT / SRT 用 `media-captions`（MIT，L1，1.0.4）；
  - IMSC1 用 imscJS（BSD-2，L1，1.1.5；传递依赖 `sax` 为 ISC）；（2026-10-19 实施补充：imscJS 与 sax 是 CommonJS，sax 会 `require` Node 内置模块，webpack 5 与 esbuild 浏览器构建因此直接失败，所以构建时把两者预打包进 TTML 懒加载块，Node 内置模块换成空实现，见 REUSE §4。）
  - CEA-608 用 hls.js `cea-608-parser.ts` + `output-filter.ts`（L3）。
  
  三个解析器都在第一次需要时动态加载。
- 自定义渲染器自写：实现 WebVTT 的 `region`、`line`、`position`、`size`、`align`、`vertical` 不做（M2 不支持竖排，单列在报告中），以及自动避让（同一时刻多条 cue 不重叠，按 WebVTT 规范的 line 计算后再上移）。
- 定位基准是 `Surface.contentRect`，即画面实际矩形而不是容器，所以有黑边时字幕仍贴着画面。底部再减去 `OverlayHost.safeArea.bottom`，控制栏显示时字幕上移，隐藏时回落。
- 引擎带内字幕：hls.js 设 `renderTextTracksNatively: false`，用 `NON_NATIVE_TEXT_TRACKS_FOUND` / `CUES_PARSED` 取 cue；Shaka 使用自定义 `textDisplayFactory`。原生 `TextTrack` 路径（`mode: 'native'`）仍然保留，iPhone 系统全屏必需。
- 尊重 `::cue` 用户偏好的方式是暴露 `--otter-cue-*` CSS 变量；`prefers-reduced-motion` 时关闭滚动类字幕的过渡。

### 5. InputController（`input`）

- 实现 SPEC §14.3 全表。键盘事件绑在播放器根上，并带焦点陷阱：Tab 和 Shift+Tab 在播放器内循环，Esc 关菜单，然后退出全屏。（2026-10-19 修订：焦点只在播放器处于模态时（默认为全屏，宿主可以通过 `modal` 选项扩展）才困在内部。内联播放器困住 Tab 违反 WCAG 2.1.2（No Keyboard Trap），e2e 断言最后一个控件之后 Tab 会离开播放器。菜单打开时焦点由菜单按 APG 菜单按钮模式管理。）
- 指针：单击、双击、长按、左右半区竖滑、横滑、双指捏合；`pointer: coarse` 下单击只切换控件显隐。
- 全部可重映射（`setHotkeys` / `setGestures`）。焦点落在文本输入框或可编辑区时不拦截按键。
- 同步派发：action 在原始事件回调内同步 `dispatch`。`toggle-fullscreen` / `toggle-pip` 在 M2 派发给 presentation；presentation 完整实现在 M3，M2 由临时 handler 调用 `requestFullscreen` / `requestPictureInPicture`，并且同样在原回调内同步执行。
- 快捷键表与键盘模型参考 Vidstack `MediaKeyboardController`（L3，MIT），在 REUSE §4 原有一行内登记。

### 6. UI 原语与无障碍

- `ui-core` 补全 SPEC §14.1 的全部原语：PlayButton、MuteButton、VolumeSlider、TimeSlider、TimeDisplay、LiveIndicator、Menu / MenuItem、Tooltip、Gesture、Poster、Spinner、Announcer；外加 CaptionsButton、FullscreenButton、PipButton、SettingsMenu 这几个组合件。
- 每个原语都用原生语义元素（`button`、`input[type=range]`），或者完整实现 ARIA 模式（menu、menuitemradio、slider 的 `aria-valuetext`），并且有可见焦点（3 px 外框，对比度 ≥ 3:1）。
- Announcer 是 `aria-live=polite` 的区域，播报播放 / 暂停、音量、字幕开关、清晰度切换和错误。
- 原语不硬编码文案，标签与播报文案走 `strings` 表（默认英文 + 中文），以后的 i18n 只需替换这张表。
- 默认皮肤 `ui-skin-default` 只有 CSS：以 Vidstack default layout 为参考（L2 vendoring 改为 L4），布局重写，用 `--otter-*` 变量，支持 `prefers-reduced-motion`、`prefers-contrast` 和 `pointer: coarse`。理由：REUSE §4 原计划 L2 vendoring Vidstack 的 CSS，但它与 Vidstack 自己的元素与 data 属性强耦合，换成 `otter-*` 原语后几乎要全部重写，复制过来反而多一层改名噪音。REUSE §4 同步修改。
- 验收：
  - axe 零 serious / critical；
  - 全部控件键盘可达，焦点可见（e2e 逐控件 Tab 遍历并截图检查外框）；
  - Vidstack CVAA 清单逐条，清单与结果写入 `docs/reports/M2.md`；
  - 黑边场景字幕贴画面（e2e 断言 cue 盒在 `contentRect` 内）；
  - 控制栏显隐时字幕安全区上移和回落（e2e 断言 cue 盒底边随 `safeArea` 变化）。

## 代价

- 规则栈接管 hls.js / Shaka 的 ABR 后，这两个引擎在网络较差时的成熟调优（例如 hls.js 的 `abrBandWidthFactor`、Shaka 的 switch interval）要由我们承担；`abr: 'engine'` 开关保留退路。
- 自定义 cue 渲染器与 Shaka 的 text displayer 契约绑定，Shaka 升级时要复核。
- 默认皮肤改为 L4 重写，比 L2 复制工作量大，但没有改名维护成本。
