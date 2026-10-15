# Otter 图标资产

主图标采用方案 B「O 播放环」：粗体字母 O 画成青色圆环，环内白色播放三角，环底化入两道水波。一个元素同时表达 Otter（水獭 / 水）、播放、流媒体。备选方案 A（几何水獭头）保留在 `../icon-concepts/` 作为文档站吉祥物素材。

## 源文件（手工矢量，可编辑）

| 文件 | 用途 | 说明 |
|---|---|---|
| `otter-icon.svg` | 主图标，64px 及以上 | 1024 画布，渐变背景与渐变描边，双水波带挖空 |
| `otter-icon-small.svg` | 16 到 48px 变体 | 更粗的环、更大的三角、单水波、无渐变 |
| `otter-symbol.svg` | 透明背景单色符号 | `currentColor` 着色，用于 favicon.svg、行内文档、wordmark 的 O |
| `otter-wordmark.svg` | 横版字标 | 符号作 O，后接 `tter`，发布前把文字转曲 |

## 构建

```bash
python3 scripts/build-icons.py   # 依赖 cairosvg pillow icnsutil
```

输出到 `dist/`：

| 路径 | 内容 |
|---|---|
| `png/icon-{16…1024}.png` | 22 个尺寸，含 iOS/Android/桌面所有常用规格；≤48 用 small 变体 |
| `favicon.ico` | 16 / 32 / 48 |
| `favicon.svg` | 跟随 `prefers-color-scheme` 的单色符号 |
| `otter.ico` | Windows，16 / 24 / 32 / 48 / 64 / 128 / 256 |
| `otter.icns` | macOS，16 至 512@2x 全套 |
| `pwa/icon-192.png`、`icon-512.png`、`maskable-512.png` | PWA manifest，maskable 已按 80% 安全区留白 |
| `social/og-1200x630.png` | Open Graph 分享图底板 |
| `preview-light.png`、`preview-dark.png` | 多尺寸对照 |

## 色板（与 `--otter-*` CSS 变量对齐）

| 变量 | 值 | 用途 |
|---|---|---|
| `--otter-bg` | `#243447` | 图标背景、深色主题面板 |
| `--otter-bg-deep` | `#1E2D40` | 背景渐变终点 |
| `--otter-accent` | `#1EE9E6` | 青色主色，环与水波，深色背景上使用 |
| `--otter-accent-deep` | `#12C9D4` | 渐变终点；浅色背景上的符号色（对比度达标） |
| `--otter-fg` | `#FFFFFF` | 播放三角、文字 |

## 几何规格（1024 画布）

- 圆角矩形 `rx=228`（约 22%，接近 macOS squircle 观感）。
- 环心 `(512, 468)`，半径 246，描边 108（外径 300、内径 192）。
- 播放三角顶点 `(458,380) (640,468) (458,556)`，描边 40 圆角，视觉中心右移 14。
- 水波两条：主波描边 46，副波 34；环被水波挖空的间隙分别为 96 与 80。
- small 变体：环描边 140，三角放大约 15%，单水波描边 80。

## 使用规则

- 深色底用 `--otter-accent`，浅色底用 `--otter-accent-deep`，不要在浅色底直接用 `#1EE9E6`。
- 图标周围留白至少为图标边长的 10%。
- 不拉伸、不旋转、不改变三角方向、不换成其他形状的水波。
- 透明符号在 24px 以下不要单独使用，改用带底的 small 变体。
