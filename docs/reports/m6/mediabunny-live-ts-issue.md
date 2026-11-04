# mediabunny issue draft: live MPEG-TS audio packets are released one or two PES late

Draft for the mediabunny issue tracker (https://github.com/Vanilagy/mediabunny). Not filed: the
owner files it (2026-11-04).

---

**Title:** MPEG-TS from a ReadableStreamSource: an audio PES is only read once the next PES starts, and its last packet once the PES after that starts

**Version:** mediabunny 1.61.6

**What happens.** Reading a live MPEG-TS stream (H.264 + AAC/ADTS, one PES = 16 AAC frames ≈ 341 ms)
through `ReadableStreamSource` and `EncodedPacketSink.getNextPacket`, the bytes paced like a live
origin (300 ms ahead of real time):

1. No AAC packet of a PES is returned before the first TS packet of the *next* PES of the same PID
   has arrived, although the audio PES carry `PES_packet_length` (so the PES is known to be complete
   when its last TS packet arrives). `PacketReadingContext.bufferData` → `readSection(…, true)`
   reads up to the next payload_unit_start of the PID.
2. The last packet of each PES is returned only once the PES *after* the next one has arrived:
   `PacketBuffer.readNext` → `ensureCurrentPacketHasNext` needs the next packet to compute the
   current one's duration, and by (1) that packet is not available until then.

Measured on a 24 s test stream: all 358 AAC packets are returned only after the next PES started
arriving, and the 16th packet of each PES about 440 ms after the other fifteen. A player that
plays the audio as it is demuxed runs dry on every PES's last frame.

**Suggestions.**
- Finish a PES when `PES_packet_length` bytes have been read (fall back to the next
  payload_unit_start only when the length is 0, as for video).
- For audio codecs with a fixed frame duration (AAC: 1024 / sample rate, also MP3, AC-3 …), compute
  the packet duration from the codec instead of waiting for the next packet.

**Repro.** A ReadableStream that enqueues a TS file in whole 188-byte packets at its byte rate plus
300 ms; log `performance.now()` for each audio packet from `EncodedPacketSink` against the arrival
time of the TS packet that starts its PES and of the one that starts the next PES.

**Workaround we use.** Our adapter reads ADTS frames from the same byte stream itself (PES complete
at `PES_packet_length`, duration 1024 / sample rate) and uses mediabunny for video only.
