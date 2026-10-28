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
- SPEC §23 的 Q2 / Q4 / Q5 / Q6 已随本 ADR 标为结案（2026-10-28）。
- 发布工作流需要 `id-token: write` 权限，而且只能跑在 GitHub 托管的 runner 上。
- 1.0 的发布说明里要把「未在真机验证」的 iPhone 项列为已知限制（测试收口轮的决定第四节）。
