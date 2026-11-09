---
"@otter-player/core": minor
"@otter-player/media": patch
"@otter-player/presets": patch
---

`player.events` now emits `error` for every error as it happens, as `OtterError` documented: each error reported on the QoE hook is forwarded, including the ones the session then retries or falls back from. Before, the session's errors reached only the QoE hook and, once the load ended, the store, so a host listening on `events` saw nothing while a blocked playlist was retried for about 20 s. A fatal error on `events` may still be recovered; `status: 'error'` in the store marks the end of the load. A failed capability detection is now reported on the QoE hook too.
