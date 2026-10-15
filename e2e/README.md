# e2e：Playwright 真机矩阵与 axe

夹具站点 `e2e/site/` 由 Vite 直接从各包源码提供服务（别名与 Vitest 相同）。每个项目都跑同一组用例：

- `smoke.spec.ts`：各包在真实浏览器中可加载；core 在 module Worker 中运行（验证零 DOM）。
- `a11y.spec.ts`：axe 扫描 WCAG 2.2 AA 标签，serious / critical 违规即失败，完整结果作为附件存入报告。

## 项目

| 项目 | 类型 | 运行条件 |
|---|---|---|
| `desktop-chrome` / `desktop-firefox` / `desktop-safari` | 桌面浏览器 | 默认（本地与 CI） |
| `emulated-iphone` / `emulated-android` | 设备模拟 | 默认。只能发现视口与触控回归，**不计入真机矩阵** |
| `real-iphone-safari` | 真机 | 设置 `OTTER_REAL_IOS_WS_ENDPOINT` |
| `real-android-chrome` | 真机 | 设置 `OTTER_REAL_ANDROID_WS_ENDPOINT` |
| `real-tv-<platform>` | 真机 TV | 设置 `OTTER_REAL_TV_CDP_URL`，可选 `OTTER_REAL_TV_PLATFORM`（`tizen` / `webos`，默认 `tizen`） |

AGENT §2.6：只在桌面 Chrome 上测过的播放功能视为未完成；`emulated-*` 不能替代 `real-*`。

## 真机接入

- `*_WS_ENDPOINT`：Playwright 协议端点（`browserType.connect`），由设备云或自建 `playwright run-server` 提供。
- `OTTER_REAL_TV_CDP_URL`：Chrome DevTools Protocol 端点（`chromium.connectOverCDP`）。Tizen 走 `sdb` 端口转发远程调试，webOS 走开发者模式 `ares-inspect`。
- 设备必须能访问夹具站点。二选一：
  - `OTTER_E2E_EXPOSE=1`：dev server 监听 `0.0.0.0`，设备通过局域网访问，同时把 `OTTER_E2E_BASE_URL` 设为 `http://<host-ip>:4173`；
  - 自行启动隧道，把 `OTTER_E2E_BASE_URL` 指向隧道地址（设置后 Playwright 不会自行启动 webServer）。

```bash
pnpm e2e                                   # 全部已启用项目
pnpm e2e --project='desktop-*'             # 只跑桌面
OTTER_REAL_TV_CDP_URL=http://127.0.0.1:9222 OTTER_REAL_TV_PLATFORM=webos pnpm e2e --project='real-tv-*'
```

## 已知限制（M0）

- 两条接入路径都只用本机替身验证过：CDP 用本地 Chromium 的 `--remote-debugging-port`，Playwright 协议用 `playwright run-server`，还没有接过真实设备。
- iPhone Safari：Playwright 只能驱动 WebKit，不能直接驱动 iOS 上的 Safari。真机要靠设备云的 Playwright 端点，能否支持真实 iOS Safari 取决于供应商，接入前先确认。
- 老电视的 Chromium 内核可能低于 `connectOverCDP` 的支持范围（Playwright 只保证较新的 Chromium），接入前需在目标机型上验证。
- WebKit 依赖 Debian / Ubuntu 系统库，RHEL 系主机上无法安装，`desktop-safari` / `emulated-iphone` 在 CI（Ubuntu / macOS）上运行。
