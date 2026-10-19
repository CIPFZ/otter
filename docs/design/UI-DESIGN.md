# Otter UI 设计规范 v1

- 日期：2026-10-19
- 状态：已采纳，作为 `ui-skin-default` 的设计基线
- 适用：`ui-core`、`ui-skin-default`、`text`、stats 面板
- 效果参照：`Assets/design/mockup-desktop-controls.png`、`Assets/design/mockup-settings-menu.png`
- 关联：SPEC §14、§22；ADR-006（图标集与材质降级）

## 1. 现状问题（基于 M2 截图）

| 问题 | 表现 | 根因 |
|---|---|---|
| 控制栏是一块硬边黑条 | 底部不透明黑色矩形，中间还有透明断裂 | 没有渐变遮罩（scrim），控件组各自带背景 |
| 进度条与控制栏割裂 | 进度条在黑条之上独立悬浮，粗细和圆角不统一 | 没有把进度条当作控制栏的一部分布局 |
| 图标不成体系 | 填充方块、填充圆、实心齿轮混用，无法分辨功能 | 用了占位图形，没有图标集 |
| 设置菜单像表单 | 44px 行高、加粗大字、一级平铺所有选项、分组标题灰小 | 没有二级结构，没有「当前值 + 进入」模式 |
| Stats 面板像终端 | 等宽字体、无对齐、无分组、遮住画面 | 没有视觉层级 |
| 焦点环刺眼 | 青色粗框包住齿轮 | 焦点环没有与元素形状和尺寸匹配 |
| 字幕朴素 | 纯黑底白字、无圆角、无字距 | 只做了 CVAA 必需项 |
| 整体没有「层」 | 所有东西都贴在画面上，没有景深 | 没有阴影、模糊、透明度体系 |

一句话总结：功能齐全，但没有一个视觉系统。

## 2. 参照分析：各家播放器拿什么

| 播放器 | 拿来的东西 | 不拿的东西 |
|---|---|---|
| YouTube | 底部 scrim 渐变而非黑条；进度条 3px 平时、悬停 5px；缩略图预览卡；图标统一线性、无按钮底；设置菜单「行 = 图标 + 标签 + 当前值 + 箭头」的二级结构；左上角标题随 scrim 出现 | 红色品牌色；稍显拥挤的右侧按钮群 |
| Bilibili | 右侧文字型按钮（「1080P 高清」「倍速」）比纯图标更易懂；弹幕开关与弹幕输入栏的位置；画质菜单直接悬浮在按钮上方而不是统一设置里；控制栏 hover 时上浮、离开淡出的节奏；进度条上的章节/高能点 | 视觉过于密集；弹幕栏占高度 |
| 腾讯视频 | 深色磨砂弹层（glass）；画质列表用「清晰度 + 标签（蓝光/臻彩）」双行；右上角投屏、PiP 常驻 | 大量会员营销元素 |
| 爱奇艺 | 悬停进度条显示「时间 + 缩略图 + 章节名」三合一；设置用分段控件（倍速 0.5/0.75/1/1.25/1.5/2 一排）而非列表 | 过多的角标与广告位 |
| Netflix | 控件极少，默认隐藏，鼠标静止 3 秒就全部淡出；进度条只有一根线；大而稀疏的 48px 图标；字幕有描边和半透明底 | 对非沉浸场景过于克制 |
| Vidstack / video.js v10 默认皮肤 | 组件尺寸系统（32/40/48）、CSS 变量命名、`::part()` 暴露方式、菜单的 ARIA 结构 | 它们的默认配色（我们已有品牌色） |
| Apple TV / iOS 播放器 | 磨砂玻璃材质、圆角 12px、动效曲线 ease-out 200ms、音量滑块的粗圆角胶囊 | 全系统的毛玻璃代价（弱机器降级） |

设计方向：YouTube 的骨架 + Bilibili 的信息密度 + Apple 的材质，统一到 Otter 品牌色。

## 3. 设计原则

1. 画面优先：UI 永远是叠加层，默认透明，只在需要时出现；没有不透明色块压在画面上。
2. 三层景深：画面 → scrim/glass → 控件。每一层用透明度和模糊区分，而不是用边框。
3. 一套图标：全部线性、2px 描边、24px 网格、圆角端点；来自同一个图标集。
4. 一个强调色：`--otter-accent` 只用于「当前进度、选中态、live 指示」，其他一律白色系。
5. 动效有节奏：出现 150ms ease-out，消失 250ms ease-in；hover 放大 1.1；无弹跳。
6. 可读性兜底：所有白色文字与图标在最亮画面上也有 `text-shadow` 或 scrim 保证对比。
7. 不牺牲既有无障碍：焦点环、ARIA、高对比与 reduced-motion 模式全部保留，只改观感。

## 4. 设计令牌（Design Tokens）

全部以 CSS 变量定义在 `:host` / `otter-player`，皮肤只改变量值。

### 4.1 颜色

| 变量 | 值 | 用途 |
|---|---|---|
| `--otter-accent` | `#1EE9E6` | 已播进度、选中勾、live 点、滑块填充 |
| `--otter-accent-deep` | `#12C9D4` | 焦点环、hover 时的 accent |
| `--otter-fg` | `rgba(255,255,255,0.92)` | 图标、主要文字 |
| `--otter-fg-muted` | `rgba(255,255,255,0.64)` | 次要文字（时间、当前值） |
| `--otter-fg-dim` | `rgba(255,255,255,0.40)` | 禁用、占位 |
| `--otter-track` | `rgba(255,255,255,0.22)` | 进度条与滑块底轨 |
| `--otter-buffered-color` | `rgba(255,255,255,0.45)` | 已缓冲区间（`--otter-buffered` 是缓冲百分比，ADR-006 §3） |
| `--otter-scrim-bottom` | `linear-gradient(to top, rgba(0,0,0,0.80) 0%, rgba(0,0,0,0.68) 45%, rgba(0,0,0,0.35) 70%, transparent 100%)` | 底部遮罩，高度 120px（2026-10-19 修订：为满足 §11.3 的 4.5:1 加深，见 ADR-006 §3） |
| `--otter-scrim-top` | `linear-gradient(to bottom, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.60) 45%, transparent 100%)` | 顶部遮罩，高度 88px（同上） |
| `--otter-glass` | `rgba(18,22,30,0.88)` | 菜单、tooltip、stats 面板底 |
| `--otter-glass-blur` | `16px` | `backdrop-filter`，不支持时 glass 透明度提到 0.96 |
| `--otter-glass-border` | `rgba(255,255,255,0.08)` | 弹层 1px 内描边 |
| `--otter-hover` | `rgba(255,255,255,0.10)` | 菜单行 hover |
| `--otter-live` | `#FF4D4F` | live 红点 |
| `--otter-danger` | `#FF6B6B` | 错误态 |

### 4.2 尺寸与间距

| 变量 | 值 | 说明 |
|---|---|---|
| `--otter-control-size` | `40px` | 按钮点击区（桌面）；`pointer: coarse` 下 48px |
| `--otter-icon-size` | `24px` | 图标绘制尺寸 |
| `--otter-bar-height` | `56px` | 控制栏行高 |
| `--otter-bar-padding-x` | `12px` | 控制栏左右内边距 |
| `--otter-gap` | `4px` | 按钮间距（视觉上靠 40px 点击区留白） |
| `--otter-progress-height` | `3px` | 进度条默认；hover / 拖动 `5px` |
| `--otter-progress-thumb` | `13px` | 拖动圆点，默认 0 缩放，hover 出现 |
| `--otter-radius-sm` | `4px` | 小标签、tooltip |
| `--otter-radius` | `8px` | 按钮 hover 底、缩略图 |
| `--otter-radius-lg` | `12px` | 菜单、面板 |
| `--otter-menu-width` | `280px` | 设置菜单 |
| `--otter-menu-row` | `40px` | 菜单行高 |

### 4.3 字体

| 变量 | 值 |
|---|---|
| `--otter-font` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif` |
| `--otter-font-mono` | `ui-monospace, "SF Mono", Menlo, Consolas, monospace`（仅 stats 面板数值列） |
| 时间文字 | 13px / 500 / `font-variant-numeric: tabular-nums` |
| 菜单标签 | 14px / 500 |
| 菜单当前值 | 13px / 400 / `--otter-fg-muted` |
| 菜单分组标题 | 11px / 600 / 字距 0.06em / 大写 / `--otter-fg-dim` |
| 标题（顶部） | 16px / 600，单行省略 |
| 文字型按钮（1080P、1.0x） | 13px / 600 |

### 4.4 阴影与动效

| 变量 | 值 |
|---|---|
| `--otter-shadow-pop` | `0 8px 32px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.06) inset` |
| `--otter-text-shadow` | `0 1px 2px rgba(0,0,0,0.6)` |
| `--otter-ease-out` | `cubic-bezier(0.2, 0, 0, 1)` |
| `--otter-ease-in` | `cubic-bezier(0.4, 0, 1, 1)` |
| `--otter-t-fast` | `120ms` |
| `--otter-t-show` | `150ms` |
| `--otter-t-hide` | `250ms` |

`prefers-reduced-motion` 下所有过渡时长归零，保留状态变化。

## 5. 图标集

- 来源：Lucide（ISC 许可证，REUSE 登记为 L1），统一 24px、2px 描边、圆角端点；缺失的媒体图标（弹幕、剧场模式、画质档位）按同样网格自绘并放入 `ui-core/src/icons/`。
- 实现：内联 SVG `currentColor`，每个图标一个导出函数，按元素注册时 tree-shake；禁止 icon font，禁止 PNG。
- 清单（必须）：play、pause、replay、skip-forward、skip-back、volume-high、volume-low、volume-mute、captions、captions-off、settings、theater、theater-exit、pip、pip-exit、fullscreen、fullscreen-exit、airplay、cast、check、chevron-right、chevron-left、chevron-down、live-dot（自绘）、danmaku-on/off（自绘）、spinner（自绘，描边旋转）、error、close。
- 状态切换（play/pause、volume 级别、fullscreen）要用同一图标的形变或交叉淡入 120ms，不是硬切。

## 6. 布局

### 6.1 控制栏（桌面）

```text
┌────────────────────────────────────────────────────────────────────┐
│ [顶部 scrim]  标题                                     airplay cast │
│                                                                    │
│                        （画面）                                      │
│                                                                    │
│ [底部 scrim 120px]                                                  │
│  ──────●────────────────────────────────── 进度条 3px，全宽，离边 12px │
│  ▶  ⏭  🔊━━   12:34 / 48:20          1080P  1.0x  CC  ⚙  ▭  ⧉  ⛶  │
└────────────────────────────────────────────────────────────────────┘
```

- 进度条在控制行之上 8px，宽度 = 容器宽 − 2×12px，左右与第一个/最后一个按钮的图标对齐。
- 左组：播放、下一个（有播放列表时）、音量（图标 + hover 展开 72px 滑块）、时间。
- 右组：画质文字按钮、倍速文字按钮、字幕、设置、剧场、PiP、全屏。文字按钮在 `< 640px` 宽时收进设置菜单。
- 直播：时间位置换成 `● 直播` 红点标签，落后时变为 `回到直播` 可点击胶囊。
- 按钮无底色；hover 时图标 `scale(1.1)` 且不透明度到 1；active 时 `scale(0.95)`。
- 显隐：鼠标移动显示，静止 2.5s 或移出容器后淡出（播放中）；暂停时常驻；焦点在控件上时常驻。

### 6.2 进度条细节

- 三层叠加：底轨 `--otter-track` → 已缓冲 `--otter-buffered` → 已播 `--otter-accent`。
- hover：高度 3→5px，出现 13px 圆形 thumb（accent，带 2px 深色外描边），光标处显示预览卡：缩略图 160×90 圆角 8px + 时间胶囊 + 章节名（有则显示）。
- 章节：有章节时底轨按章节分段，段间 2px 间隙；hover 到的章节段加粗。
- 拖动中：预览卡跟随，画面不动，松手 seek（移动端同理）。
- 键盘：方向键 5s，Shift 方向键 10s，Home/End；焦点时 thumb 常显并有焦点环。

### 6.3 顶部栏

- 仅在控件显示时出现，与底部同节奏。
- 左：标题（宿主传入，无则不渲染顶部栏文字但 scrim 仍可配置关闭）。
- 右：AirPlay / Cast（能力存在时）、关闭（嵌入小窗模式时）。

### 6.4 中央反馈层

- 大播放按钮：仅在未开始播放（海报态）时显示，72px 圆形 glass 底 + 32px 播放图标。
- 操作反馈：双击快进/快退显示半透明圆形 + `+10s` 文字，从中心 0.8→1 放大并淡出 500ms；音量/亮度调整显示竖向胶囊指示器；倍速长按显示 `2x ▶▶` 顶部胶囊。
- Loading：spinner 48px，2px 描边，accent 色，背景无遮罩；超过 800ms 才出现，避免闪烁。
- 错误：中央 glass 卡片，图标 + 一句话 + 「重试」按钮。

### 6.5 移动端（`pointer: coarse` 或宽度 < 640px）

- 按钮 48px，图标 26px。
- 进度条常驻 3px，thumb 常显 11px，拖动时 16px。
- 中央显示 播放/暂停 + 前后 10s 三个按钮（Bilibili / YouTube 移动端模式），单击画面切换控件显隐。
- 右上角：画质、倍速收进设置；全屏按钮保留在右下。
- 竖屏信息流 preset：只保留进度条和静音按钮。

## 7. 设置菜单

- 锚定在齿轮按钮上方 8px，右对齐，`--otter-menu-width` 280px，glass 材质，12px 圆角，`--otter-shadow-pop`，1px `--otter-glass-border`。
- 一级：行 = 图标 24px + 标签 + 右侧当前值（muted）+ chevron-right。行高 40px，左右内边距 16px。开关类（弹幕、stats）右侧用 toggle switch 而不是进入二级。
- 二级：顶部返回行（chevron-left + 分类名，44px），下面选项列表，选中项左侧 check 图标 accent 色，其余留 24px 占位对齐。切换一级/二级用水平滑动 150ms。
- 画质选项双行：主行 `1080P`，副行 `高清 · 2.5 Mbps`（有信息时）；`自动` 后跟当前实际档位 `自动 (720P)`。
- 倍速：用分段控件一排 `0.5 0.75 1.0 1.25 1.5 2.0`，选中项 accent 底 + 深色字，不进二级。
- 字幕样式：进入二级后是预览区（当前 cue 实时预览）+ 各设置项，与 CVAA 要求一致。
- 出现动效：`opacity 0→1` + `translateY(8px→0)` 150ms；关闭 100ms。
- 最大高度 = 容器高 − 控制栏 − 24px，内部滚动，滚动条细线样式。

## 8. Stats 面板

- 位置左上角，距边 12px，顶部 scrim 之下；宽度 auto，最大 360px；glass 材质，8px 圆角。
- 两列：标签列 `--otter-fg-muted` 11px，数值列 `--otter-font-mono` 11px `--otter-fg`；行高 18px。
- 分组用 6px 间距分隔：播放（Status / Format / Backend / Resolution / Codec）、网络（Quality / Bandwidth / Buffer / Latency）、质量（TTFF / Rebuffers / Switches / Dropped / Errors）、Route 折叠区。
- 右上角有关闭 × 和复制按钮（复制为 JSON）。
- 数值变化时不闪烁；带宽用 2 位有效数字 + 自动单位；时间用 `ms` 或 `s` 自动切换。

## 9. 字幕

- 默认样式：字号 `max(13px, 画面高度 × 3.6%)`（1080p 画面约 39px，360p 画面 13px；2026-10-19 修订，原为 15px 下限、1080p = 36px），CVAA 字号选项按倍数作用于这个基准、`--otter-font`、字重 500、白字、`text-shadow: 0 0 4px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.9)`、底色 `rgba(0,0,0,0.55)`、内边距 `4px 10px`、圆角 4px、行高 1.35、字距 0.01em。
- 多行 cue 每行独立底色（YouTube 方式），不是整块。
- 位置：底边距画面底 8%，控制栏显示时再上移控制栏高度 + 8px，过渡 150ms。
- 字幕窗口（CVAA「窗口颜色与不透明度」，2026-10-19 M3 加入）：整条 cue 外框的底色，默认透明；用户可在设置里选半透明或不透明（黑色），与逐行底色叠加。
- CVAA 用户设置优先于默认样式。

## 10. 状态与细节

| 状态 | 表现 |
|---|---|
| hover 按钮 | 图标 opacity 0.92→1，scale 1.1，tooltip 400ms 后出现（glass，11px，圆角 4px，位于按钮上方 8px） |
| 焦点（键盘） | 2px `--otter-accent-deep` 外环，offset 2px，圆角跟随元素；鼠标点击不显示焦点环（`:focus-visible`） |
| 禁用 | opacity 0.4，无 hover |
| 选中（菜单） | 左侧 check accent，文字 `--otter-fg` |
| Live | 红点 6px + `直播` 文字；落后 > 3s 时整个标签变为可点击胶囊 `回到直播`，accent 描边 |
| 高对比模式 | scrim 改为纯黑 0.85，accent 改黄 `#FFD60A`，去掉 blur |
| forced-colors | 使用系统色，边框显式 1px |

## 11. 验收标准（M2.5）

1. 五张对照截图（海报态、播放中控件显示、hover 进度条、设置菜单一级与二级、stats 面板）与 `Assets/design/mockup-*.png` 风格一致，由用户目视验收。
2. 图标全部来自同一集合，无占位图形。
3. 控制栏在任何画面（纯白、纯黑、彩条）上文字与图标对比度 ≥ 4.5:1（axe 验证）。
4. 控件显隐、菜单出现、hover 放大三个动效时长与曲线符合 §4.4；reduced-motion 下无动画。
5. 设置菜单二级结构可键盘往返，焦点不丢失。
6. 体积：`ui-skin-default` CSS ≤ 8KB gzip；图标按用到的注册，短视频场景自有代码仍 ≤ 30KB。
7. M2 的全部 a11y 与 CVAA 用例保持通过。

## 12. 不做

- 不做亮色主题（播放器永远深色叠加）。
- 不做会员、广告、营销角标。
- 不做弹幕输入栏（属于宿主页面）。
- 不引入 UI 框架或 CSS 框架。
