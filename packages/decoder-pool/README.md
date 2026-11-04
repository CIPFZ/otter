# @otter-player/decoder-pool

Shared Worker decode pool: decoder plugins run in pooled Workers, at most 16 at once, frames come back transferred.

Part of [Otter](https://github.com/CIPFZ/otter), a pluggable web video player. Most hosts do not import it directly: the scenario presets (`@otter-player/presets`) assemble it. For your own composition, see `createPlayer` there.

The API reference is the TSDoc in this package (rendered on the Otter docs site).
