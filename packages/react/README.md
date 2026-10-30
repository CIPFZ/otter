# @otter-player/react

React 绑定（SPEC §16，ADR-013 第三批）：一个承载 preset 播放器的组件，加一个读 store 的 hook。只经 store 的 `getState` / `subscribe`（宿主经 `dispatch` 下命令），不带任何 Otter 运行时；用哪个 preset 由宿主传入。React ≥ 18（peer）。

```tsx
import { useState } from 'react';
import { OtterPlayer, useOtterState } from '@otter-player/react';
import { createVodPlayer } from '@otter-player/presets/vod';
import type { Player } from '@otter-player/presets';
import '@otter-player/ui-skin-default';

export function Video({ src }: { src: string }) {
  const [player, setPlayer] = useState<Player | null>(null);
  const paused = useOtterState(player?.store, (s) => s.paused);
  return (
    <>
      <OtterPlayer
        create={(container) => {
          const p = createVodPlayer({ container, title: '示例' });
          void p.load(src);
          return p;
        }}
        deps={[src]}
        onPlayer={setPlayer}
        poster="/poster.jpg"
      />
      <button onClick={() => player?.store.dispatch(paused ? 'play' : 'pause', undefined)}>{paused ? '播放' : '暂停'}</button>
    </>
  );
}
```

- `<OtterPlayer create deps onPlayer aspectRatio poster className style id>`：播放器在挂载后的 effect 里创建，放在组件盒子里一个新建的子容器中；卸载或 `deps` 变化时销毁，子容器一并移除。Strict Mode 的「挂载、卸载、再挂载」得到的是两个互不相干的播放器，最后剩一个。
- `useOtterState(store, selector, equals?)`：只在所选的那一片变化时重渲染（`equals` 默认 `Object.is`）。`store` 为 null / undefined 时（还没有播放器、服务端）返回 undefined。
- `useOtterPlayer(create, deps)`：组件背后的 hook，自己出盒子时用。

## 服务端渲染

- 渲染时不碰 `window`、`document`、`AudioContext`。服务端与客户端首次渲染的输出相同：一个空盒子，带 `aspect-ratio`（默认 16 / 9，预留位置，不跳版）和可选的 poster 背景。水合之后才建播放器。
- 各 preset 的 sub-path 在服务端可以直接 import：`pnpm check:side-effects` 在 Node 里逐个导入全部入口，并拦截浏览器全局。`defineOtterElements()` 在服务端什么也不做。
- 示例：`e2e/site/react-{basic,vod,surveillance}.html`。构建时在 Node 里渲染（`e2e/react-ssr.ts`），浏览器里 `hydrateRoot`；`e2e/react.spec.ts` 检查无水合不匹配、能播放、hook 跟随。
