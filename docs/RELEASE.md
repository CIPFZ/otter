# 发布（ADR-014）

所有发布包同一版本（changesets fixed）；1.0 之前只发 beta（npm dist-tag `beta`）。

## 现在能做的：beta 的准备与 dry-run

1. 改动要发版时加一条 changeset：`pnpm changeset`（英文，写宿主能看到的变化）。
2. 生成版本号与 CHANGELOG：`pnpm changeset version`。仓库处在 pre 模式（`.changeset/pre.json`，tag `beta`），版本是 `0.1.0-beta.N`。
3. 许可文件：`pnpm release:files` 生成各发布包的 `LICENSE` 与 `NOTICE`（第三方代码来自 `src/vendor/*/UPSTREAM.json` 与 `otter.bundle`，许可原文在 `tooling/licenses/`）。`pnpm check` 里的 `check:release-files` 检查它们是最新的。
4. dry-run：`pnpm release:dry-run`。构建后逐包 `pnpm pack`，检查每个 tarball（统一版本、没有 `workspace:`、不依赖占位包与 `@otter-vendor/*`、`exports` 的目标都在、LICENSE / README / NOTICE 都在、没有 `.tsbuildinfo`），对每个 tarball 跑 `npm publish --dry-run --tag beta`，再把全部 tarball 装进一个新项目，用 tsc 检查、用 esbuild 打包 `e2e/site/examples/` 里的示例。不发布任何东西。
5. 发布说明：`docs/release-notes/<版本>.md`（英文），changeset 的摘要指向它。

## 首发（负责人的机器，ADR-014 §3）

尚未实施：首发与 `npm trust github` 批量登记的脚本、发布工作流（OIDC、`--allow-stage-publish`）在下一步做，做完再补本节的命令。在那之前不要手动 `npm publish`。

## 占位包

`private: true`，不发布：`plugin-analytics`、`plugin-cast`、`plugin-p2p`、`plugin-record`、`plugin-screenshot`、`overlay-ads`、`text-ass`、`ui-skin-audio`、`decoder-wasm-ffmpeg`。发布包不得依赖它们（`check-boundaries`）。
