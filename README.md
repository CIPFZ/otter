# Otter

通用 Web 播放器（TypeScript），工作代号 Otter，可更名。

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
pnpm license:gate          # 许可证门禁（REUSE §2）
pnpm check:boundaries      # 包约定与分层依赖方向
pnpm check:side-effects    # 无顶层副作用（需先 build）
pnpm size                  # 体积预算（需先 build）
pnpm e2e                   # Playwright（需先 pnpm exec playwright install）
pnpm check                 # 以上非 e2e 检查全部跑一遍

node scripts/new-package.ts <name> --description "..." [--deps core,media] [--no-dom] [--css]
```
