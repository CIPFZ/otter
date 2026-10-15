# ADR-002：M0 工程基线（工具链、构建产物、空实现约定、门禁）

- 状态：已采纳
- 日期：2026-10-15
- 关联：`SPEC.md` §2、§13、§14.4、§18、§21；`AGENT.md` §4；`REUSE.md` §2、§5；ADR-001

## 背景

M0 要求 pnpm monorepo 骨架、SPEC §5 / §12 / §13 / §15 / §17 接口的类型与空实现，以及 CI 门禁（license、strict TS、Vitest、Playwright 真机矩阵、axe、size-limit）。SPEC 只规定了工具名称，没有规定版本、产物形态和空实现约定；Overlay 接口也没有指定所属的包。

## 决策

1. **工具链版本**：pnpm 12、TypeScript 7（原生编译器）、Vite 8（rolldown）、Vitest 5、Playwright 1.64、size-limit 14。根 `package.json` 锁定版本，Node ≥ 22.18（脚本直接用 Node 的类型擦除运行 `.ts`）。
2. **构建产物**：JS 由共享配置 `tooling/vite.lib.config.ts` 以 Vite library 模式输出单个 ESM 入口，所有裸导入都 external；`.d.ts` 由 `tsc -b tsconfig.build.json` 通过 project references 产出，并开启 `isolatedDeclarations`。CSS-only 皮肤包由 `tooling/copy-css.ts` 复制产物。
3. **模块解析**：包源码按 `module` / `moduleResolution: NodeNext` 编译，相对导入必须带 `.js` 扩展名，保证产出的 d.ts 对 node16 / nodenext 和 bundler 两类消费者都可用（M0 中途发现不带扩展名会导致 TS2834）。测试与 e2e 仍用 Bundler 解析。
4. **源码导出条件**：每个包的 `exports` 第一项是自定义条件 `@otter-player/source`，指向 `src/index.ts`。仓库内的类型检查（`customConditions`）、Vitest 和 e2e（别名）都直接使用源码，不必先构建依赖。
5. **空实现约定**：除 core 外，M0 的实现都是空实现，统一抛出（或 reject）`notImplemented`（`type: 'other'`、`fatal: false`）；`destroy` / 取消订阅类方法为 no-op；`FormatPlugin.probe` 返回 0、`Decoder.supports` 返回 `false`，保证选路永远不会选中它们。core（store、事件总线、插件注册、错误模型、QoE 钩子）是 SPEC §20 列出的自研部分，代码很小，M0 直接给出最小可用实现。
6. **Overlay 接口归属**：`Overlay` / `OverlayHost` / `Insets` 定义在 `surface` 包。理由：OverlayHost 给出的是 Surface 的画面实际矩形（SPEC §13），而 SPEC §18 没有独立的 overlay 基础包；放在 surface 不新增包，overlay-* / text / danmaku 都只依赖 core + surface。
7. **门禁全部用自写脚本实现**（REUSE §5 允许自写）：
   - `scripts/license-gate.ts`：遍历 pnpm 完整依赖树（prod + dev），解析 SPDX 表达式。GPL 系在任何位置都失败；LGPL 只允许出现在 `decoder-*` / `text-ass` 的运行时依赖里，按最近的 workspace 包判定归属；tooling 专用许可证（如 lightningcss 的 MPL-2.0）只允许出现在 dev 依赖；未知许可证必须显式 override。
   - `scripts/check-boundaries.ts`：检查包约定（命名、ESM、`sideEffects`（见第 10 条）、Apache-2.0、只用 `exports`）、core 无依赖且无 DOM、render 包与 engine 实现包之间互不依赖、所有导入都已声明、tsconfig references 与依赖一致。
   - `scripts/check-side-effects.ts`：esbuild 打包时开 `ignoreAnnotations`，任何构建后的 JS 包在不被使用时都必须被摇成空产物；皮肤包只检查 `dist/` 中没有任何 JS（见第 10 条）。
8. **size-limit 使用 esbuild 插件**（`@size-limit/esbuild` + `@size-limit/file`，gzip）。没用默认的 `preset-small-lib`，因为它的 rolldown 已不支持打包 CSS，无法度量「皮肤 + ui-core + presentation + text」这一预算。另外，多个文件同时 `import: '*'` 会生成重复的标识符（size-limit 14 的 bug），所以组合预算改用 `tooling/size/default-ui.js` 作为入口。
9. **Playwright 矩阵分三层**：`desktop-*`、`emulated-*`（不计入真机矩阵）、`real-*`（通过环境变量接入：Playwright `wsEndpoint` 或 TV 的 CDP）。细节见 `e2e/README.md`。
10. **CSS-only 皮肤包的 `sideEffects` 例外（原 SPEC §23 Q7，2026-10-15 结案）**：`ui-skin-*` 四个包声明 `"sideEffects": ["*.css"]`，这样在 JS 里 `import '@otter-player/ui-skin-*'` 时 CSS 不会被打包器摇掉；`<link>` 与 CSS `@import` 同样可用。代价是皮肤包必须保持纯 CSS：禁止任何 `.js` / `.ts` 源文件、入口或导出，不得有 tsconfig，`exports` 只能指向 `.css`。`check-boundaries` 强制这些约束（例外只对 `ui-skin-*` 生效，其他包仍必须是 `sideEffects: false`），`check-side-effects` 对皮肤包只检查 JS 产物为空。

## 代价与风险

- TypeScript 7 与 Vite 8 都是新主版本，周边工具的兼容性要持续观察；出问题时可以回退到 TS 6 / Vite 7，不涉及源码改动。
- esbuild 的 postinstall 已在 `pnpm-workspace.yaml` 的 `allowBuilds` 中拒绝（二进制通过 optionalDependencies 安装）。Playwright 1.64.1 发布时间太短，被 pnpm 自动加入 `minimumReleaseAgeExclude`，升级时需要复核。
- 真机路径只用本机替身验证过（本地 Chromium 的 CDP、`playwright run-server`），能否真正覆盖 iOS Safari 取决于设备云供应商。
- 皮肤包的 `["*.css"]` 例外意味着打包器会无条件保留被引入的皮肤 CSS，未使用的选择器不会被摇掉；按需加载由「引不引入哪个皮肤包」来控制。
