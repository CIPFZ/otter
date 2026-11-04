# AGENT.md：Otter 协作规则

本文件面向在本仓库工作的 AI 智能体与开发者。先读 `SPEC.md`，再读 `REUSE.md`，最后读本文件。

## 1. 项目速览

- Otter（2026-10-27 定名）：100% TypeScript 的通用 Web 播放器，引擎可插拔、可组合、取百家之长。
- 文档：`RESEARCH.md`（生态调研与事实依据）、`SPEC.md`（架构与里程碑）、`REUSE.md`（复用来源与等级）、`docs/decisions/`（ADR）。
- 当前阶段：M0、M1 已完成（M1 报告见 `docs/reports/M1.md`）；M2 已验收（`docs/reports/M2.md`，ADR-005）；M2.5 视觉系统已验收（`docs/reports/M2.5.md`，ADR-006）；M3 已交付、待验收（`docs/reports/M3.md`，ADR-007）。工程基线见 ADR-002，引擎契约见 ADR-003，真机与体积口径见 ADR-004。

## 2. 不可违背的约束

1. 语言：TypeScript strict，不引入 Rust / 其他编译到 WASM 的自研代码。WASM 只能是 `decoders/*` 与 `text-ass` 中的第三方产物，独立加载。
2. 引擎可插拔：任何格式、backend、ABR、DRM、Decoder、Renderer、UI 功能都必须以 `SPEC.md` 定义的接口接入。不得让 `core` 依赖任何具体实现。
3. 分层纪律：UI / Overlay / Presentation 只读 store、只派发 action，禁止直接操作引擎或 `<video>`。
4. 用户手势：全屏、PiP、横屏锁、带声自动播放必须在同一事件回调内同步调用。
5. 体积预算是验收项（见 `SPEC.md` §1.1、§19），超预算的提交不算完成。
6. 真机矩阵：iPhone Safari、Android Chrome、桌面 Chrome/Firefox/Safari、至少一台 Tizen 或 webOS。只在桌面 Chrome 测过的播放器功能视为未完成。M1–M6 阶段以桌面三大浏览器真机 + CI 上的 WebKit 与模拟移动端为准，手机与 TV 真机在 M7「移动端与 TV 真机回归」对最终代码一次性补跑（ADR-004、ADR-009）。
7. 引擎库（hls.js / Shaka / mpegts.js / WASM 解码器）只能按需以 chunk 加载，不得进入首屏；SPEC §19 的「自有代码」体积是 M1–M6 门禁，「含引擎」体积自 M5 自研引擎落地起逐步门禁（ADR-004、ADR-009）。

## 3. 复用规则

- 复用前先在 `REUSE.md` 查来源与等级；没列出的来源先补表再用。
- 四级：L1 依赖 / L2 子包 vendoring / L3 文件级复制 / L4 只借设计（工程含义，ADR-008）。
- 任何开源项目的代码都可以直接引入、拷贝、修改，只需在 vendored 文件头和 UPSTREAM.json 里记录来源，便于日后 diff 上游。

## 4. 工程约定

- 包管理 pnpm，构建 Vite，单测 Vitest，E2E Playwright，无障碍 axe。
- `tsconfig`：`strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax`。
- 全 ESM，每个包 `sideEffects: false`，禁止顶层副作用。唯一例外是纯 CSS 皮肤包 `ui-skin-*`：声明 `"sideEffects": ["*.css"]`，包内禁止任何 `.js` / `.ts` 入口、源文件与 tsconfig，`exports` 只能指向 `.css`（ADR-002 第 10 条，由 `check-boundaries` 与 `check-side-effects` 强制）。
- 工具链新主版本在里程碑中阻塞超过一天即退回上一 LTS 主版本，回退单独提交并记入 ADR-002（第 11 条）。
- 公开 API 用 `interface`；内部可用 class。
- 二进制：`ArrayBuffer` 走 Transferable；热路径用对象池；禁止在 demux/remux 中创建闭包。
- 错误：统一错误模型（`SPEC.md` §4），禁止吞错；每个 fatal 错误必须附降级路径。
- 事件：类型安全总线，禁止字符串拼接事件名。
- 命名：包名 `@otter-player/<name>`，Web Components 前缀 `otter-`，CSS 变量前缀 `--otter-`，事件前缀无（用类型约束）。
- **`_` 前缀 = 包内部字段**（2026-10-27，ADR-013）：在 package.json 里有 `otter.mangle` 的包（目前只有 format-hls），只在本包内部传递的对象的字段一律以 `_` 开头，构建时 esbuild `mangleProps: /^_/` 把它们改成短名；同一次构建的所有块共用一个 mangle cache（提交在仓库）。公共 API、发给其他包的对象（事件负载、错误、传给 core / media / pipeline 的参数）、模块导出名、动态 import 取的成员，一律不加 `_`。没有 `otter.mangle` 的包不要用 `_` 前缀字段。发布形态由 CI 的 `OTTER_E2E_DIST` 一步验证。
- 新包一律用 `node scripts/new-package.ts` 生成；包内相对导入带 `.js` 扩展名（NodeNext）。
- 未实现的能力统一抛出 / reject `notImplemented`（非 fatal），不得静默 no-op（ADR-002）。
- 提交前跑 `pnpm check`：来源记录、边界、strict TS、Vitest、无顶层副作用、体积预算，任何一项失败都阻断。
- **没进入就 skip，不许 pass**（2026-10-27）：e2e 里测某个模式（全屏、PiP、Document PiP、某个渲染器、某种编码……）时，环境不支持或没有真正进入该模式，必须 `test.skip(true, 原因)`，并留一条 CI 通知写明原因；不得留一条通知就让用例通过。
- **验证「无手势」行为的用例，断言前不许 `page.evaluate`**（2026-10-28）：Playwright 的 `page.evaluate` 带用户手势执行，trace 的 DOM 快照也会让页面从第一份文档起就有手势（RESEARCH §1）。这类用例关掉 trace（文件顶层 `test.use({ trace: 'off' })`），用 init script 驱动页面，状态经 `exposeBinding` 或 console 消息取回，断言完才允许 evaluate。例：`e2e/no-gesture.spec.ts`。
- **文档语言分界**（2026-11-04 负责人）：TSDoc、文档站（`scripts/docs-site.ts` 生成）、包 README、源码注释用英文；`SPEC.md` / ADR / `RESEARCH.md` / 报告 / 本文件用中文。中文文档站排在 1.0 之后，不进发版范围。UI 文案表（`strings.ts` 等）不受此限。术语的中英对照见 `docs/design/GLOSSARY.md`，英文写法以它为准。
- **TSDoc 六条约定**（2026-11-04 负责人；`pnpm check:docs-site` 强制其中能机检的部分）：
  1. 摘要一行，说它做什么、什么时候用，不复述类型（不写「A string」「Options for X」）。
  2. 选项接口（`*Options`、`*Props`）的可选成员必写 `@defaultValue`（没有默认值时写 `@defaultValue none` 并说明缺省行为）；`@param` / `@returns` 只在名字和类型说不清时写。
  3. `createPlayer`、十个 preset 的 `create*Player`、三个绑定（React / Vue 的 `OtterPlayer`、Svelte 的 `otterPlayer`）带 `@example`，代码取自 e2e 示例站（`e2e/site/` 里 `// #region example:<名字>` 标出的片段，逐字一致，由门禁比对），不另写。
  4. 错误码用表格：`OtterError` 的 TSDoc 里一张「代码 | 类型 | 致命 | 何时出现」表，源码里出现的每个 `details` 码都要在表里，表里每一行都要在源码里出现（门禁双向比对）。
  5. `@see` 与 `{@link}` 只指向公开导出（某个入口导出的名字），不指内部函数或文件。
  6. 术语表放 `docs/design/GLOSSARY.md`（2026-11-04 定稿）。公开 API 已有标识符的概念，表跟 API 走；想改名的列在术语表末尾的「改名候选」由负责人定，不在 TSDoc 里改。
  - 覆盖门禁只管用户面向入口：core、presets 全部 sub-path、react / vue / svelte、ui-core、input（含 `/remote`）、各 `format-*`、各 `engine-adapter-*` 与 `engine-pipeline` 的入口。这些入口的导出必须 100 % 有文档注释，导出接口的每个成员也必须有（`UiStrings` 每个键一行）；纯结构类型（如 `Unsubscribe` 这种只是函数签名别名的）按 `入口#名字` 列进 `scripts/lib/docs-gate.ts` 的 `STRUCTURAL` 才可免；镜像第三方结构的类型（Shaka 的 track / error / variant 等）列进 `MIRRORS`，成员免逐个注释，但类型注释必须写明上游（`Upstream: shaka.extern.Track`）。内部包只在文档站首页记录覆盖率，不门禁。
  - **评审清单（提交前人工过一遍，门禁查不了）**：diff 里新增或改动的 TSDoc，摘要是否说了做什么 / 何时用而不是复述类型（约定 1）；用词是否与术语表一致；`@defaultValue` 写的是否真是代码里的默认值。
- **注释与提交信息只写观测到的事实**（2026-11-04 负责人）：原因、机制这类判断，没有数据证实之前必须写明是假设（「假设：…，待 CI 数据验证」），不得写成「X 因为 Y」「已修复」。验证后改成事实或删掉。起因：`c2b3dfe` 的提交信息与 `audio-feed.ts` 注释把未验证的「Safari 的 AAC 解码器压两帧」写成了原因，下一次 CI 的数据否定了它。
- **删除只用 `rm`**（2026-11-04）：不要把任何东西 `mv` / `cp` 到 `/dev/null`（root 下会把设备换成普通文件），也不要经仓库外的符号链接删除仓库里的文件。
- **`pnpm check` 返回 0 才提交**（2026-10-26）：以退出码为准，不看输出里有没有报错字样；命令链里要显式判断（`pnpm -s check; [ $? -eq 0 ] && git commit …`），检查失败时不得提交或推送。

## 5. 工作流程

1. 任何新能力先问三件事：属于哪个包；接口是否已在 `SPEC.md`；来源与等级是否已在 `REUSE.md`。缺一项先补文档再写代码。
2. 先适配后替换：HLS/DASH/DRM 先走 hls.js / Shaka / mpegts.js 适配器，QoE 有数据后再决定替换。
3. 直接在 `main` 上小步提交并推送，保持 CI 绿；每个里程碑在 `docs/reports/Mx.md` 附：体积报告（size-limit）、真机矩阵结果、axe 结果。
4. 遇到浏览器差异先查 `RESEARCH.md` §1 与 `SPEC.md` §15 的坑表；新发现的坑追加到表里。
5. 决策变更写 ADR（`docs/decisions/ADR-xxx.md`），格式参照 ADR-001。
6. **汇报**（2026-10-29 负责人）：照四段（做了什么 / 测试结果 / 偏离或疑问 / 下一步建议）。
   - 汇报前必须等最后一次提交的 CI 跑完；汇报第一行写 CI 的提交号与各组结果（typecheck…size、e2e chromium + firefox、e2e webkit 等）。
   - CI 任一组红时不许写「通过」，红的组列在「偏离或疑问」第一条。
   - `pnpm check` 不含 e2e：本地绿不等于 CI 绿。

## 6. 明确不做

- 不做服务端（打包、转码、许可证服务器、P2P tracker）。
- 不做 Roku、Flash 回退、IE。
- 不支持 VVC/H.266。
- 不自写 EME/DRM 流程、不自写解码器。
- 不在 `core` 中引用 DOM 类型。

## 7. 测试资产

- hls.js `tests/test-streams.js`、Shaka `demo/common/assets.js`、DASH-IF 参考流作为公开测试源起点。
- 本地测试源用 ffmpeg / Shaka Packager 生成 CMAF（cbcs）双清单样本。
- 弹幕性能基准：5000 条/分钟 60fps。
- 监控基准：16 路 720p HEVC。

## 8. 开放问题跟踪

见 `SPEC.md` §23。任何开放问题有结论后写 ADR 并从 §23 移除。
