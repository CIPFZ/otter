# Otter

通用 Web 播放器（TypeScript），名称 Otter（2026-10-27 定名），npm scope `@otter-player/*`。

| 文件 | 内容 |
|---|---|
| `RESEARCH.md` | Web 播放器生态全景：浏览器底层能力、格式/协议/编码、开源引擎、UI 框架、商业产品、大厂自研设计 |
| `SPEC.md` | 架构规格：卷一引擎层、卷二渲染层、卷三包清单 / 场景矩阵 / 里程碑 |
| `REUSE.md` | 集百家之长的复用来源、四级等级、许可证红线、vendoring 流程 |
| `AGENT.md` | 协作与工程规则 |
| `docs/decisions/` | ADR 决策记录 |
| `THIRD_PARTY_NOTICES.md` | vendored / 复制代码的来源与许可证声明 |
| `Assets/icon/` | 图标源文件、构建脚本输出与资产说明 |

状态：M0 骨架。SPEC §18 的 43 个包已全部落地（接口 + 空实现），CI 门禁已就位。下一步 M1。

## 目录

| 路径 | 内容 |
|---|---|
| `packages/*` | `@otter-player/*` 各包，一个目录一个包 |
| `tests/` | 跨包契约测试（各包空实现是否符合 SPEC 接口） |
| `e2e/` | Playwright 设备矩阵与 axe 扫描，见 `e2e/README.md` |
| `scripts/` | 门禁与工具脚本（`node scripts/<name>.ts` 直接运行） |
| `tooling/` | 共享构建配置 |

## 命令

需要 Node ≥ 22.18 与 pnpm 12。

```bash
pnpm install
pnpm build                 # Vite 产出 JS，tsc -b 产出 d.ts，输出到 packages/*/dist
pnpm typecheck             # strict TS（包源码 + 测试 / 脚本）
pnpm test                  # Vitest
pnpm check:boundaries      # 包约定与分层依赖方向
pnpm check:side-effects    # 无顶层副作用；全部入口（含 sub-path）在 Node 里可导入、不碰浏览器全局（需先 build）
pnpm check:docs-text       # docs/ 与顶层 *.md 里没有控制字符
pnpm size                  # 体积预算（需先 build）
pnpm e2e                   # Playwright（需先 pnpm exec playwright install）
pnpm check                 # 以上非 e2e 检查全部跑一遍

node scripts/new-package.ts <name> --description "..." [--deps core,media] [--no-dom] [--css]
```

## 界面语言

控件文字（含 aria-label、提示、读屏用的时间）按以下顺序选表：

1. 宿主用 `provideStrings(root, table)` 给的表；
2. 最近的 `lang` 属性（preset 的 `lang` 选项就设在播放器根上）；
3. `navigator.language`；
4. 英文。

自带英文与中文（`zh*`）。数字与时间格式（`0:09`、`720P`、`1.0x`）不翻译。加一种语言：照 `STRINGS_EN` 写一张 `UiStrings` 表（`locale` 填它的 BCP 47 标签），用 `provideStrings` 挂在播放器根上；画面、弹幕、统计这几页的文字可以放在表的 `picture`、`danmakuPage`、`stats` 里覆盖。用法见 `packages/presets/README.md`。
