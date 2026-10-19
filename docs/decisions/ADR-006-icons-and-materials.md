# ADR-006：图标集与材质降级策略（M2.5 视觉系统）

- 状态：已采纳
- 日期：2026-10-19
- 关联：`docs/design/UI-DESIGN.md` §4、§5、§10、§11；`SPEC.md` §14.4、§21；`REUSE.md` §4；ADR-002（副作用与体积门禁）

## 背景

M2.5 按 UI-DESIGN v1 重做 `ui-core` 与 `ui-skin-default` 的视觉层，store、action 与 ARIA 结构不变。其中有两件事需要定下来，并且以后不应每个皮肤各自决定：

1. 图标从哪里来，怎样进入产物；
2. 玻璃材质（`backdrop-filter`）在不支持或不合适的环境下怎样退化，以及它和对比度验收之间的关系。

## 决策

### 1. 图标集：Lucide（L1，ISC）

- 用 npm 包 `lucide`（1.59.0，ISC；部分图标源自 Feather，MIT）。理由：
  - 统一的 24 px 网格、2 px 线性描边、圆角端点，UI-DESIGN §5 的清单它几乎全有（play、pause、volume-*、captions / captions-off、settings、maximize / minimize、picture-in-picture-2、airplay、cast、check、chevron-*、circle-alert、x 等）；
  - 每个图标是一个纯数据导出（`IconNode` 数组），可以按需导入；
  - 许可证在 REUSE §2 白名单内。
  
  备选项与不选的原因：Material Symbols 以图标字体为主（UI-DESIGN 禁止 icon font）；Heroicons 缺媒体图标；Phosphor 的线宽体系与设计稿不一致。
- 渲染：`ui-core/src/icons.ts` 把 `IconNode` 转成内联 SVG（`stroke="currentColor"`、`aria-hidden="true"`、`focusable="false"`）。可访问名称始终在控件上，图标只做装饰。
- Lucide 没有的三个图形（live 点、spinner 圆环、剧场）在 `icons.ts` 按同样网格和描边自绘；以后的弹幕开关、画质档位角标也放在这里。
- 入产物方式：`ui-core` 的 `package.json` 设 `otter.bundle: ["lucide"]`，构建时把用到的图标预打包进 dist。原因有两点：
  - 副作用门禁会把入口里对第三方模块的静态 import 判为副作用（ADR-002）；
  - 消费方因此不需要再解析 `lucide`。
  
  每个元素的工厂只引用自己用到的图标，图标常量是纯数据，消费方只注册部分元素时，其余图标照样被 tree-shake 掉。
- 状态切换（播放 / 暂停、音量三级、全屏进出、字幕开关）在按钮里同时渲染各状态的 SVG，用 120 ms 透明度与缩放交叉淡入，不硬切；`prefers-reduced-motion` 下时长为 0。

### 2. 材质降级

- 玻璃材质（菜单、tooltip、stats 面板、中央反馈、错误卡片、大播放按钮）由三部分组成：`--otter-glass` 底色（0.88 不透明）、`backdrop-filter: blur(var(--otter-glass-blur, 16px))`，以及 1 px 内描边和投影。
- **不支持 `backdrop-filter`**（`@supports not (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: …)`）：底色换成 `--otter-glass-solid`，不透明度 0.96。这条规则写在每个用到玻璃的原语的 shadow CSS 里，不依赖皮肤。
- **`prefers-contrast: more`**：`--otter-glass-blur: 0px`，底色纯黑，描边白色，scrim 改为 0.85 纯黑，强调色换成 `#FFD60A`（UI-DESIGN §10）。
- **`forced-colors: active`**：用系统色（`Canvas` / `CanvasText` / `Highlight`），边框显式 1 px。
- 弱机器上的模糊开销：宿主可以把 `--otter-glass-blur` 设为 `0px`，此时与「不支持」一样走 0.96 底色。当前没有自动探测设备性能，留到 M5.5 真机回归时，按实测帧率再决定。

### 3. scrim 与对比度验收（对 UI-DESIGN §4.1 的偏离）

- §11.3 要求控制栏文字与图标在任何画面（纯白、纯黑、彩条）上对比度 ≥ 4.5:1。按 §4.1 给出的 scrim 渐变实测（`e2e/visual.spec.ts`，截屏取每个控件中心区域最亮的像素），纯白画面上顶部标题只有 **2.0:1**，按钮行也只有 3:1 左右。
- 验收优先：保留渐变的形状，加深按钮行与标题所在的位置：
  - 底部：0.80 → 0.68（45%）→ 0.35（70%）→ 透明；
  - 顶部：0.72 → 0.60（45%）→ 透明。
  
  `e2e/visual.spec.ts` 在三种画面上逐个控件断言 ≥ 4.5:1。
- 移动端中央控件直接压在画面上，没有 scrim，所以给它们加 0.6 黑色圆底（纯白画面上 5.1:1）。
- 令牌命名有一处偏离：§4.1 的 `--otter-buffered`（颜色）改名为 `--otter-buffered-color`。原因是 `--otter-buffered` 从 M1 起已经是进度条已缓冲百分比的变量。

## 代价

- 预打包意味着 `lucide` 升级要重新发布 `ui-core`，宿主不能单独升级图标库。M2.5 用到的图标约 25 个，体积已计入 `ui-skin-default + ui-core + presentation + text` 预算（27.1 / 30 KB）。
- 每个用到玻璃的原语都带同一段降级 CSS，shadow DOM 里有重复。体积尚可，如果以后逼近预算，可以改用 constructable stylesheet 共享。
- scrim 比设计稿深，暗场画面上的控制栏区域会显得更「重」。验收截图需要用户目视确认这个取舍。
