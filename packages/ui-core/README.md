# @otter-player/ui-core

无头 UI 原语（SPEC §14.1）：`otter-*` Web Components、chrome 状态与 i18n 文案表。样式由皮肤（`@otter-player/ui-skin-*`，纯 CSS）提供；原语的 shadow root 只放结构与默认值，读下面这些公开的 CSS 变量。

## 公开 CSS 变量

皮肤与宿主可以在播放器根（`[data-otter-player]`）或 `:root` 上设置；没设时用括号里的默认值。

| 变量 | 默认 | 作用 |
|---|---|---|
| `--otter-accent`、`--otter-accent-deep` | `#1ee9e6`、`#12c9d4` | 强调色、焦点环 |
| `--otter-fg`、`--otter-fg-muted`、`--otter-fg-dim` | 白，0.92 / 0.64 / 0.4 透明度 | 文字颜色 |
| `--otter-control-size`、`--otter-icon-size` | 40 px、24 px | 按钮与图标尺寸 |
| `--otter-glass`、`--otter-glass-blur`、`--otter-glass-border` | 见 UI-DESIGN §4.1 | 菜单与提示的玻璃材质 |
| `--otter-menu-width`、`--otter-thumbnail-width` / `-height` | 280 px、160 × 90 px | 菜单与预览卡 |
| `--otter-cue-*` | — | 字幕的用户偏好（ADR-005 §4） |
| **`--otter-ui-text-scale`** | `1` | **所有面向用户的文字字号的倍数**：控制栏的文字按钮（清晰度、倍速）、时间显示、直播徽标、菜单、预览卡、提示、反馈徽标、错误卡、统计面板。只放大文字，不放大按钮与面板的盒子。`ui-skin-tv` 在控制栏上用 2.34（13 px → 30 px），在不支持 CSS `zoom` 的浏览器上也用它放大菜单 |

各原语的 `part` 名（`::part(button)`、`::part(menu)`、`::part(preview)` 等）也是公开接口，见 `src/elements.ts` 的模板。
