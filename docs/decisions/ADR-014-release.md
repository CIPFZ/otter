# ADR-014：发布（包、版本、发布流程、许可、浏览器基线、CDN、文档站）

- 状态：已采纳，**M6 第二批第三停完成后再实施**
- 日期：2026-10-28
- 关联：`SPEC.md` §1.1、§19、§21、§23；ADR-001（只用 TypeScript）、ADR-004（体积口径）、ADR-013（M6 批次）；`docs/reports/M6.md`「测试收口轮」

## 背景

负责人在测试收口轮的决定（2026-10-28）里定了发布方式。本 ADR 先把决定记下来，第三停（`presets/basic`、ott-drm、surveillance、shorts）做完后再动手。1.0 要等 M7 结束，在那之前只发 beta。

## 决定

### 1. 包

- 发布的包都在 `@otter-player/*` 下。这个 org 已经建好。每个发布包写 `publishConfig.access = "public"`。
- 占位包写 `private: true`，不发布。现有的占位包有：
  - `plugin-cast`、`plugin-p2p`、`plugin-record`、`plugin-analytics`、`plugin-screenshot`；
  - `overlay-ads`、`ui-skin-audio`、`text-ass`；
  - 以及实施时清点出的其余占位包。
- 另外发一个不带 scope 的 `otterplayer` 占位包，只占名字。它的 README 指向 `@otter-player/presets`。

### 2. 版本

- 用 changesets，fixed 模式：所有发布包同一个版本号。
- 从 `0.1.0-beta.x` 开始。M7 结束前不发 1.0。

### 3. 发布流程

1. **首发**在负责人的机器上进行。
   - 首发脚本放在 `scripts/`。
   - 同一个脚本里用 `npm trust github` 给所有包批量登记可信发布。
2. **之后**用 GitHub Actions 可信发布：
   - OIDC，`permissions: id-token: write`，GitHub 托管的 runner，不用 npm token。
   - 登记时带 `--allow-stage-publish`：CI 只做 stage，负责人执行 `npm stage approve` 后才真正发布。
3. 发布工作流的文件名登记后**永不改名**，因为可信发布的登记绑定这个文件名。
4. 操作步骤写进 `docs/RELEASE.md`。

### 4. 许可

- Apache-2.0。
- 凡是包含 L2 / L3 拷入代码的包，各自带一份 `NOTICE`，列出来源与原许可。来源本来就记在各处的拷入注释里，实施时从那里汇总。

### 4a. 发布包的许可规则（2026-11-04 负责人；替代 ADR-008 §1「不分发、无义务」的前提）

- 公开包只能含：
  - MIT、BSD-2-Clause、BSD-3-Clause、Apache-2.0、ISC、0BSD；
  - MPL-2.0：文件保持原许可，在该包的 NOTICE 里列出。
- LGPL 只限独立加载的产物，不进 tarball（公开包的文件里不能有）；GPL / AGPL 不得进公开包。
- 门禁输入：拷入文件的来源头（`// Derived from <project>@<commit> <path> <许可>`）与目录的 `UPSTREAM.json` 的 `license`（来源头优先，两者都没有即不通过；`license` 对公开包里的拷入代码不再可选），打包进 dist 的 npm 包，以及生产依赖树（`dependencies` + `peerDependencies`，递归到底，跳过工作区包——它们各自单独审）里每个第三方包的 `license`。
- 执行：`scripts/lib/licenses.ts`，由 `scripts/release-files.ts` 在写文件与 `--check`（`pnpm check`）之前对每个公开包核对，任一不合规即失败；`--audit` 输出下表。单测 `scripts/test/licenses.test.ts`。
- 处理：`decoder-wasm-hevc`（Jessibuca jv4-decoder 产物，GPL-3.0，内含 FFmpeg）改为 private。`presets/surveillance` 不再依赖它，改为 `decoders` 选项由宿主注入，默认只有 WebCodecs；HEVC 流在没有 HEVC 解码器、也没有注入 WASM 解码器时，WebCodecs 后端报非致命 `hevcDecoderUnavailable`，该路随后照常失败。发布说明的已知限制加了一条。M7 候选：自建 LGPL 的 HEVC WASM（独立加载，不进 tarball）。

审计结果（2026-11-04，37 个公开包，`node scripts/release-files.ts --audit`；私有的 10 个不在表里）：

| 包 | 拷入代码（src/vendor） | 打包进 dist | 生产依赖树（第三方） | 结论 |
|---|---|---|---|---|
| `backend-mse` | Apache-2.0: hls.js | — | — | OK |
| `backend-native` | — | — | — | OK |
| `backend-webcodecs` | — | — | — | OK |
| `core` | — | — | — | OK |
| `danmaku` | MIT: CommentCoreLibrary, danmaku | — | — | OK |
| `decoder-pool` | — | — | — | OK |
| `decoder-webcodecs` | — | — | — | OK |
| `demux-mediabunny` | — | — | MPL-2.0: mediabunny@1.61.6; MIT: @types/dom-mediacapture-transform@0.1.12, @types/dom-webcodecs@0.1.13 | OK (MPL-2.0 in NOTICE) |
| `engine-adapter-hlsjs` | — | — | Apache-2.0: hls.js@1.7.3 | OK |
| `engine-adapter-mpegts` | — | — | Apache-2.0: mpegts.js@1.8.2; MIT: es6-promise@4.2.8, events@3.3.0 | OK |
| `engine-adapter-shaka` | — | — | Apache-2.0: shaka-player@5.2.13 | OK |
| `engine-pipeline` | — | — | — | OK |
| `format-dash` | — | — | — | OK |
| `format-file` | — | — | — | OK |
| `format-flv` | — | — | — | OK |
| `format-hls` | Apache-2.0: hls.js, video.js | — | — | OK |
| `format-mp4-range` | — | — | BSD-3-Clause: mp4box@2.4.1 | OK |
| `format-ts` | — | — | — | OK |
| `format-whep` | — | — | — | OK |
| `input` | — | — | — | OK |
| `media` | — | — | Apache-2.0: @svta/cml-cmcd@2.8.2, @svta/cml-structured-field-values@1.1.6, @svta/cml-utils@1.6.1 | OK |
| `overlay-thumbnails` | — | — | MIT: media-captions@1.0.4 | OK |
| `overlay-watermark` | — | — | — | OK |
| `pipeline` | BSD-3-Clause: dash.js; Apache-2.0: hls.js, mpegts.js | Apache-2.0: hls.js, mpegts.js | — | OK |
| `preferences` | — | — | — | OK |
| `presentation` | — | — | — | OK |
| `presets` | — | — | — | OK |
| `qoe` | — | — | — | OK |
| `react` | — | — | MIT: react@19.3.1 | OK |
| `surface` | — | — | — | OK |
| `svelte` | — | — | MIT: svelte@5.57.3, @jridgewell/remapping@2.3.5, @jridgewell/gen-mapping@0.3.13, @jridgewell/sourcemap-codec@1.6.0, @jridgewell/trace-mapping@0.3.31, @jridgewell/resolve-uri@3.1.2, @sveltejs/acorn-typescript@1.0.13, @types/estree@1.0.9, acorn@8.19.0, clsx@2.1.1, devalue@5.9.4, esm-env@1.2.2, esrap@2.4.0, is-reference@3.0.3, locate-character@3.0.0, magic-string@0.30.21, zimmerframe@1.1.5; Apache-2.0: aria-query@5.3.1, axobject-query@4.1.0 | OK |
| `text` | — | BSD-2-Clause: imsc@1.1.5; ISC: sax@1.2.1 | MIT: media-captions@1.0.4 | OK |
| `ui-core` | — | ISC: lucide@1.59.0 | — | OK |
| `ui-skin-default` | — | — | — | OK |
| `ui-skin-minimal` | — | — | — | OK |
| `ui-skin-tv` | — | — | — | OK |
| `vue` | — | — | MIT: vue@3.5.44, @vue/shared@3.5.44, @vue/compiler-dom@3.5.44, @vue/compiler-core@3.5.44, @babel/parser@7.29.12, @babel/types@7.29.11, @babel/helper-string-parser@7.29.11, @babel/helper-validator-identifier@7.29.7, estree-walker@2.0.2, @vue/runtime-dom@3.5.44, @vue/runtime-core@3.5.44, @vue/reactivity@3.5.44, csstype@3.2.3, @vue/compiler-sfc@3.5.44, @vue/compiler-ssr@3.5.44, magic-string@0.30.21, @jridgewell/sourcemap-codec@1.6.0, postcss@8.5.30, nanoid@3.3.20, @vue/server-renderer@3.5.44; BSD-2-Clause: entities@7.0.1; BSD-3-Clause: source-map-js@1.2.2; ISC: picocolors@1.1.1 | OK |

### 5. 浏览器基线

- 基线：Chrome / Edge 110+，Firefox 115+，Safari 16.4+，iOS 16.4+。
- 低于基线的浏览器：不加 polyfill，走原生后端，能播多少算多少。
- 写进 SPEC 和 README。

### 6. CDN

- 只给 `presets/basic` 和 `presets/vod` 出 ESM 单文件。
- 经 GitHub Release，由 jsDelivr 分发。
- 其余包只走 npm。

### 7. 文档站

- 放在 GitHub Pages：`CIPFZ.github.io/otter`。
- 内容按 ADR-013 第四批，从源码生成。

### 8. SPEC §23 开放问题结案

| 问题 | 决定 |
|---|---|
| Q2 | 保持自写的 store，不 vendoring video.js v10 的 core |
| Q4 | P2P 不进 1.0；`plugin-p2p` 保留为占位包（`private: true`） |
| Q5 | WebTransport / MoQ 等标准稳定再做 |
| Q6 | 不出 Electron 专用包；文档站加一页「在 Electron 里用」 |

## 后果

- 第三停之后的实施清单：
  - 改各包的 `package.json`（`publishConfig`、`private`）；
  - 新建 `otterplayer` 占位包；
  - 配 changesets；
  - 写首发与登记脚本、发布工作流和 `docs/RELEASE.md`；
  - 加许可文件与 `NOTICE`；
  - 把浏览器基线写进 SPEC / README；
  - 产出两个 ESM 单文件；
  - 加文档站的 Pages 部署。
- 实施进度（2026-11-04，负责人：发版准备先做 changeset、发布说明、beta 标签与 npm dry-run）：
  - 已做：各包 `publishConfig` / `private`（占位包 9 个，含实施时清点出的 `decoder-wasm-ffmpeg`）、`repository`（npm provenance 要求与仓库一致）；`check-boundaries` 加三条（发布包要么 public 要么 private、`repository.directory` 正确、发布包不依赖占位包）。
  - 已做：changesets fixed 模式，pre 模式 tag `beta`，第一条 changeset，`changeset version` 出 `0.1.0-beta.0` 与各包 CHANGELOG；发布说明 `docs/release-notes/0.1.0-beta.0.md`（英文）。
  - 已做：各发布包的 `LICENSE` 与 `NOTICE`（`scripts/release-files.ts`，`pnpm check` 校验）；浏览器基线写进 SPEC §1.1 与 README。
  - 已做：`pnpm release:dry-run`（`scripts/release-dry-run.ts`），步骤见 `docs/RELEASE.md`。dry-run 查出并已修：打包进 dist 的依赖（`@otter-vendor/*`、imsc、lucide）原来在 `dependencies` 里，发布后 npm 会去装 `@otter-vendor/*`（不存在）——改到 `devDependencies`，`check-boundaries` 拦截；`dist/.tsbuildinfo` 进了 tarball——`files` 排除；29 个包没有 README——补了最小的英文 README。
  - 已做（2026-11-04 第二轮）：首发与登记脚本 `scripts/first-publish.ts`（检查、`changeset publish`、`otterplayer`、逐包 `npm trust github … --allow-stage-publish`）；发布工作流 `.github/workflows/release.yml`（手动；dry run，或 `npm stage publish` + GitHub pre-release）与 `scripts/stage-release.ts`；`otterplayer` 占位包（`placeholder/otterplayer`）；CDN 构建 `scripts/build-cdn.ts`；Pages 工作流 `.github/workflows/pages.yml`（设变量 `PAGES_ENABLED` 后才部署）。步骤见 `docs/RELEASE.md`。均未运行（首发由负责人做）。
  - CDN 的偏离：「单文件」把按需块全内联后 basic 2.8 MB、vod 3.0 MB（hls.js、Shaka、mediabunny 都进去了），改为「一个入口文件 + 旁边的按需块」：入口 basic 18.7 kB / vod 34.8 kB gzip，块用到才按相对地址加载。另：jsDelivr 只分发 npm 包与 GitHub 仓库里的文件，不分发 GitHub Release 的附件；要 jsDelivr 直接可用，块得在 npm 包（例如 `@otter-player/presets` 带一个 `cdn/` 目录）或仓库的 tag 里。待负责人定。
  - 未做：文档站「在 Electron 里用」一页（§8 Q6）。
  - 已定（2026-11-04）：许可规则见 §4a；`decoder-wasm-hevc` 改为 private。
- SPEC §23 的 Q2 / Q4 / Q5 / Q6 已随本 ADR 标为结案（2026-10-28）。
- 发布工作流需要 `id-token: write` 权限，而且只能跑在 GitHub 托管的 runner 上。
- 1.0 的发布说明里要把「未在真机验证」的 iPhone 项列为已知限制（测试收口轮的决定第四节）。
- 发布说明的已知限制清单另有：
  - **F16**（2026-11-03；措辞 2026-11-04 负责人改定）：WebCodecs 音频路径偶发短暂无声（音频欠载，单次数毫秒到数十毫秒），多个浏览器都观察到（Chromium 的模拟 Android、桌面 Safari）。签名不是 F14 的解码队列卡在上限；原因未查明，见 RESEARCH §1。
  - **WHEP 接收端的时间伸缩**（2026-11-03）：WebRTC 的抖动缓冲由浏览器决定，会在不隐藏的情况下插入或删除样本、改变播放速度（Chrome 本地约每 20 s 插入 95–300 ms）。播放器不补偿；用接收端 `currentTime` 推算延迟或与其他源对时的地方都受影响（RESEARCH §1 F17）。
