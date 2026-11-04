---
"@otter-player/presets": minor
"@otter-player/backend-webcodecs": minor
---

surveillance: WebCodecs decoders only by default; a host adds others (a WASM HEVC decoder) with the `decoders` option, and an HEVC stream without a decoder reports the non-fatal `hevcDecoderUnavailable`.
