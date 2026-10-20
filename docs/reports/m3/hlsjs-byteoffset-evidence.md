# hls.js TS demuxer：输入视图的 byteOffset 问题（证据）

- 日期：2026-10-20
- 上游：hls.js `b023c29`（main，2026-10-19），`src/demux/tsdemuxer.ts` 第 286–293 行
- Otter：`vendor/hls.js`（L2）已修，记在 `UPSTREAM.json` 的 `localChanges`；上游 PR 由项目负责人提交
- 关联：M3 报告「L2 vendoring 流程」第 5 条

## 问题

`TSDemuxer.demux()` 在输入长度不是 188 的整数倍时，会把末尾不足一个 TS 包的字节留到下次调用：

```ts
this.remainderData = new Uint8Array(
  data.buffer,
  len,
  data.buffer.byteLength - len,
);
```

这里的 `len` 是相对于视图 `data` 的偏移，构造时却用了底层的 `data.buffer`，没有加上 `data.byteOffset`；长度也取到了整个缓冲区的末尾，而不是视图的末尾。只要传入的是大缓冲区上的一个视图（`byteOffset > 0`，或 `buffer.byteLength > byteLength`），「剩余字节」就会变成缓冲区里错误位置上的数据。下一次调用时，这些数据被拼到新 chunk 的前面。

修复：`this.remainderData = data.subarray(len);`

## 第一层：最小复现（Otter 仓库，`vendor/hls.js/test/tsdemuxer-views.test.ts`）

把 e2e 测试素材整个放进一个前后各有 4 KB 填充的大缓冲区里，按 16 KB 切成视图（`subarray`）喂给 demuxer，再和喂独立拷贝（`slice`）的结果比较。8 s、25 fps 的片段：

| 输入 | 版本 | 视频样本 | 不同的 DTS | DTS 不递增 | 音频样本 | CEA-608 cc_data（秒） |
|---|---|---|---|---|---|---|
| `cc/clip.ts` 拷贝 | 上游 | 200 | 200 | 0 | 376 | 2.421, 7.421 |
| `cc/clip.ts` 视图 | 上游 | **387** | 200 | **2** | **735** | **2.421, 7.421, 2.421, 7.421** |
| `cc/clip.ts` 视图 | 已修 | 200 | 200 | 0 | 376 | 2.421, 7.421 |
| `ts/clip.ts` 拷贝 | 上游 | 200 | 200 | 0 | 376 | — |
| `ts/clip.ts` 视图 | 上游 | **387** | 200 | **2** | **735** | — |
| `ts/clip.ts` 视图 | 已修 | 200 | 200 | 0 | 376 | — |

上游版本下有 187 个重复的视频帧（DTS 两次倒退）、359 个重复的音频帧，608 字幕数据重复一遍。原因是错位的「剩余字节」恰好是后面真实的 TS 数据，同一批包被解了两次。测试在上游写法下 2 个用例全部失败，已修版本下全部通过。

## 第二层：真实路径（Otter 自研管线，`e2e/byteoffset.spec.ts`）

先测浏览器自己的 fetch 流：Chrome 和 Firefox 读 `/ts/clip.ts`、`/cc/clip.ts` 时，所有 chunk 都是独立缓冲区（`byteOffset` 为 0，长度等于整个缓冲区），**没有一个是视图**。所以在自然取流路径上，这个问题不会出现。把 vendored 副本换成上游写法，跑 `e2e/pipeline.spec.ts`（cn-vod-ts、608 TS / FLV、cn-live-flv 等），Chrome 和 Firefox 上 14 个用例全部通过。

数据源只要会重新分块（TransformStream、Service Worker、P2P 分片、用户提供的 ReadableStream），交出来的就可能是视图。夹具的 `?chunks=views` 把每个响应 chunk 放进一个前后各有 4 KB 零填充的新缓冲区，再以视图交给播放器，以此模拟这种数据源。e2e 在页面里拦截 `SourceBuffer.appendBuffer`，统计送进 MSE 的视频帧数（各 `trun` 的 sample_count 之和）和每个 moof 的 `tfdt`，并记录播放过程中出现过的字幕 cue：

| 场景 | 浏览器 | 版本 | 送进 MSE 的视频帧（应为 200） | tfdt 倒退 | 608 轨道 / cue |
|---|---|---|---|---|---|
| cn-vod-ts | Chrome | 上游 | **173** | 0 | — |
| cn-vod-ts | Firefox | 上游 | **10** | 0 | — |
| 608 TS | Chrome | 上游 | **172** | 0 | cc1 / 1 条 |
| 608 TS | Firefox | 上游 | 未测到（608 轨道一直没有出现，用例在等待轨道时超时） | — | **无** |
| cn-vod-ts | Chrome / Firefox | 已修 | 200 / 200 | 0 | — |
| 608 TS | Chrome / Firefox | 已修 | 200 / 200 | 0 | cc1 / 1 条 |

上游版本下 4 个用例全部失败，已修版本下全部通过。真实管线里看到的现象是**丢帧和丢字幕**，不是重复：夹具给每个 chunk 单独分配缓冲区，错位取到的「剩余字节」是零填充和无关数据，跨 chunk 的 TS 包因此被损坏或丢掉。第一层里整个文件在同一块缓冲区上，错位取到的是后面的真实数据，所以表现为重复。两种现象是同一个错误在不同内存布局下的结果。MSE 层面 `tfdt` 没有倒退，因为 remuxer 会重新归一化时间戳；时间戳倒退只出现在 demuxer 的原始样本里（第一层）。

修复是在 `e3c10f2`（M3 的 CEA-608 提交）里加进 vendored 副本的。在那之前自研管线用的是上游写法，但浏览器的 fetch chunk 都不是视图，所以没有受到影响。

## 第三层：上游仓库里的复现（hls.js 自己的测试框架）

- 新增 `tests/unit/demuxer/tsdemuxer.ts`（mocha + chai，跑在 karma / Chrome Headless 上），并在 `tests/index.js` 里注册。测试自带一段合成的纯 AAC 传输流（PAT、PMT，以及 40 个各装一帧 ADTS 的 PES），不需要二进制夹具。把它放进一个前后各有 1000 字节填充的缓冲区，按 1000、500、565 字节（都不是 188 的倍数）切块，分别以拷贝和视图两种方式解复用，比较每一帧的 PTS。
- 上游 `b023c29` 未修复时：3 个用例全部失败，视图输入只解出 3、0、1 帧（应为 40）：

  ```
  AssertionError: expected [ 90000, 91920, 93840 ] to deeply equal [ 90000, 91920, 93840, 95760, (36) ]
  AssertionError: expected [] to deeply equal [ 90000, 91920, 93840, 95760, (36) ]
  AssertionError: expected [ 90000 ] to deeply equal [ 90000, 91920, 93840, 95760, (36) ]
  ```

- 应用补丁后：3 / 3 通过；上游现有的 demuxer 与 remux 单测（adts、base-audio-demuxer、base-video-parser、transmuxer、mp4-remuxer）连同新测试共 68 个，全部通过。`eslint`、`prettier --check`、`tsc --noEmit` 都没有报错。
- 补丁、测试和 PR 描述在 `tmp/hlsjs-tsdemuxer-byteoffset.md`（不进仓库）。

## 上游影响范围

hls.js 自己的管线基本不会触发这个问题：transmuxer 收到的是 `ArrayBuffer`，会重新包成 `new Uint8Array(data)`，偏移为 0、长度等于整个缓冲区。会受影响的是直接调用 `TSDemuxer.demux()` 并传入视图的代码。顺带注意到 `src/utils/fetch-loader.ts` 的渐进加载路径用的是 `onProgress(…, chunk.buffer, …)`：如果 chunk 是视图，会把整个底层缓冲区交出去。浏览器的 fetch chunk 目前都是独立缓冲区（上面实测），所以这里只在 PR 里作为观察提一下，不放进这个补丁。

## 合并之后

上游合入后，把 `vendor/hls.js/UPSTREAM.json` 里这条 `localChanges` 改为引用上游的 commit；下次 vendor-sync 时固定点前移到包含该 commit 的位置，这条本地差异就消失了。`vendor/hls.js/test/tsdemuxer-views.test.ts` 和 `e2e/byteoffset.spec.ts` 作为回归测试保留。
