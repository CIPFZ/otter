# @otter-player/svelte

Svelte 绑定（SPEC §16，ADR-013 第三批）：一个 action 与一个组件承载 preset 播放器，加一个 store 读状态。范围与 `@otter-player/react` 一致：只经 store 的 `getState` / `subscribe`，不带 Otter 运行时，用哪个 preset 由宿主传入。Svelte 5（peer）。

```svelte
<script>
  import OtterPlayer from '@otter-player/svelte/OtterPlayer.svelte';
  import { otterState } from '@otter-player/svelte';
  import { createVodPlayer } from '@otter-player/presets/vod';
  import '@otter-player/ui-skin-default';

  let { src } = $props();
  let player = $state.raw(null);
  const paused = $derived(otterState(player?.store, (s) => s.paused));
  const create = (container) => {
    const p = createVodPlayer({ container, title: '示例' });
    void p.load(src);
    return p;
  };
</script>

<OtterPlayer {create} deps={[src]} poster="/poster.jpg" onplayer={(p) => (player = p)} />
<button onclick={() => player?.store.dispatch($paused ? 'play' : 'pause', undefined)}>{$paused ? '播放' : '暂停'}</button>
```

- `OtterPlayer.svelte`（props：`create deps onplayer aspectRatio poster class`）：以源码发布（`svelte` 导出条件），由宿主的 Svelte 工具链编译；内部就是下面的 action。
- `use:otterPlayer={{ create, deps, onPlayer }}`：在元素里新建子容器并建播放器；元素移除或 `deps` 变化时销毁。自己出盒子时用。
- `otterState(store, selector, equals?)`：Svelte store（`$paused`），只在所选的那一片变化时通知。`store` 为空时值为 undefined。
- 主入口是纯 TypeScript，不导入 Svelte。

## 服务端渲染

- action 只在浏览器里、水合之后运行；它所在的元素就是服务端渲染出的空盒子（带 `aspect-ratio` 与可选 poster）。
- 服务端渲染时 Svelte 对 store 是「订阅、读值、退订」，不留监听。
- 示例：`e2e/site/svelte-{basic,vod,surveillance}.html`，构建时在 Node 里渲染，浏览器里 `hydrate`；Svelte 的生产构建不报告水合不匹配，`e2e/bindings.spec.ts` 改查服务端那个盒子元素在水合后仍是同一个。
