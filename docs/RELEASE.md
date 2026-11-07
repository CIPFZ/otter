# 发布（ADR-014）

所有发布包同一版本（changesets fixed）；1.0 之前只发 beta（npm dist-tag `beta`）。

## 现在能做的：beta 的准备与 dry-run

1. 改动要发版时加一条 changeset：`pnpm changeset`（英文，写宿主能看到的变化）。
2. 生成版本号与 CHANGELOG：`pnpm changeset version`。仓库处在 pre 模式（`.changeset/pre.json`，tag `beta`），版本是 `0.1.0-beta.N`。
3. 许可文件：`pnpm release:files` 生成各发布包的 `LICENSE` 与 `NOTICE`（第三方代码来自 `src/vendor/*/UPSTREAM.json` 与 `otter.bundle`，许可原文在 `tooling/licenses/`）。`pnpm check` 里的 `check:release-files` 检查它们是最新的。
4. dry-run：`pnpm release:dry-run`。构建后逐包 `pnpm pack`，检查每个 tarball（统一版本、没有 `workspace:`、不依赖占位包与 `@otter-vendor/*`、`exports` 的目标都在、LICENSE / README / NOTICE 都在、没有 `.tsbuildinfo`），对每个 tarball 跑 `npm publish --dry-run --tag beta`，再把全部 tarball 装进一个新项目，用 tsc 检查、用 esbuild 打包 `e2e/site/examples/` 里的示例，最后从装好的 `@otter-player/cdn` 在 Chromium 里播放两个入口。不发布任何东西。
5. 发布说明：`docs/release-notes/<版本>.md`（英文），changeset 的摘要指向它。

## 首发（负责人的机器，ADR-014 §3）

前提：Node ≥ 22.18、pnpm 12.11.2、npm ≥ 11.15（`npm trust`），已 `npm login` 且账号开了 2FA，本地 main 干净且与 origin/main 一致。先执行 `pnpm install --frozen-lockfile` 安装项目依赖，以及 `pnpm exec playwright install chromium` 准备 dry-run 的浏览器。

Windows 上的 npm、pnpm 与 `node_modules/.bin` 入口由统一的子进程工具处理；参数仍按数组传递，包含空格的路径不需要手工拼接 shell 命令。首发检查先构建，再检查许可与发布文件，确保新克隆也有 CDN 许可审计需要的 `dist/inputs.json`。

1. 先看一遍：`node scripts/first-publish.ts --dry-run`。检查照跑（许可规则与发布文件、完整的 release dry-run），发布与登记的命令只打印。
2. 首发：在交互式终端运行 `node scripts/first-publish.ts`。不要提前提供 `--otp=<码>` 或 OTP 环境变量；脚本会拒绝它们。构建和完整预演结束后，Changesets/npm 先完成自己的查询，再在实际需要 2FA 时提示输入新码或完成网页验证。stdin 与 stdout 都必须连接真实终端，不能通过管道或普通输出重定向运行正式首发；后台检查用 `--dry-run`。需要同时留存 Node 命令输出时，使用 `scripts/lib/terminal-capture.ts` 提供的预加载捕获环境，保持原有终端输入、输出与验证行为。依次：
   - `pnpm changeset publish`：发布全部公开包的当前版本，dist-tag 取 pre 模式的 `beta`，已在 npm 上的版本跳过，git tag 打在本地；
   - `otterplayer` 占位包（`placeholder/otterplayer`，不在工作区里，只发一次）；
   - 对每个公开包 `npm trust github <包> --file release.yml --repository CIPFZ/otter --allow-stage-publish --yes`，间隔 2 s。查询或登记都可能要求 2FA，按当次终端提示完成；不能假设之前的验证会覆盖之后的命令。
   - 验证码过期时等待新的 2FA 提示，再向负责人取新码，不能重复旧码。其他错误立即停止；若命令退出，先检查已发布状态，再重新运行（已发布版本会跳过）。占位包和可信发布各自按实际提示验证，不沿用首个码。
3. 推 tag：`git push origin --tags`。

## 之后的版本：发布工作流

1. 合入 changeset，本地 `pnpm changeset version` 出新版本号与 CHANGELOG，写 `docs/release-notes/<版本>.md`，提交推送，等 CI 绿。
2. GitHub Actions 手动运行 **Release**（`.github/workflows/release.yml`，**文件名永不改**：可信发布绑定它）。不勾 `stage` 只跑 dry run；勾上则对 npm 上还没有的版本逐包 `npm stage publish`（OIDC，无 token；`@otter-player/cdn` 也在内），并建 GitHub pre-release（发布说明）。
3. 负责人逐包批准：`npm stage list <包>`，`npm stage approve <stage-id>`（2FA）。批准前不公开。

## CDN（ADR-014 §6）

`@otter-player/cdn` 是普通的公开包，随其他包一起发布；它的 `build`（`scripts/build-cdn.ts`）在 presets 与皮肤之后出 `dist/otter-basic/`、`dist/otter-vod/`：入口 `otter-*.esm.js`（gzip：basic 14.2 kB，vod 30.6 kB）、按需块 `chunks/`、皮肤 CSS。jsDelivr 地址：`https://cdn.jsdelivr.net/npm/@otter-player/cdn@<版本>/dist/otter-vod/otter-vod.esm.js`（固定版本：块的文件名随版本变）。release dry-run 把它从 tarball 装好，在 Chromium 里按 URL 导入两个入口并播放夹具。

## 文档站（ADR-014 §7）

`.github/workflows/pages.yml`：main 上影响文档的推送都会构建（`OTTER_DOCS_PAGES=1`：只有文档，「运行」链接换成「在仓库里 `pnpm docs:serve`」的说明）；仓库设置里 Pages 的来源选 GitHub Actions、并设变量 `PAGES_ENABLED=true` 之后才部署到 `https://cipfz.github.io/otter/`。

## 占位包

`private: true`，不发布：`plugin-analytics`、`plugin-cast`、`plugin-p2p`、`plugin-record`、`plugin-screenshot`、`overlay-ads`、`text-ass`、`ui-skin-audio`、`decoder-wasm-ffmpeg`、`decoder-wasm-hevc`（GPL 内容，ADR-014 §4a）。发布包不得依赖它们（`check-boundaries`）。
