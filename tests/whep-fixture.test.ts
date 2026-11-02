// The local WHEP fixture (e2e/whep.ts) stops sending when the receiver goes away without a DELETE
// (M6, 2026-11-02: a page that just closed left its session sending for the rest of the preview
// server's life, through the whole e2e step). A werift receiver in this process stands in for the
// browser: connect, see packets, then close it; the sender must stop within 1 s.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';
import { answer, parseIvf, parseOggOpus, type Clip } from '../e2e/whep.ts';

const clip = (): Clip => ({ ...parseIvf(readFileSync('e2e/media/whep/clip.ivf')), opus: parseOggOpus(readFileSync('e2e/media/whep/tone.ogg')) });
// werift's DTLS record builder is not in its exports map: loaded by path.
const req = createRequire(import.meta.url);

/** A receiving peer: offer, the fixture's answer, a count of RTP packets received. */
async function receiver(silenceMs?: number) {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [new RTCRtpCodecParameters({ mimeType: 'video/VP8', clockRate: 90_000 })],
      audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48_000, channels: 2 })],
    },
    iceAdditionalHostAddresses: ['127.0.0.1'],
    iceServers: [],
  });
  let packets = 0;
  pc.addTransceiver('video', { direction: 'recvonly' }).onTrack.subscribe((t) => t.onReceiveRtp.subscribe(() => packets++));
  pc.addTransceiver('audio', { direction: 'recvonly' }).onTrack.subscribe((t) => t.onReceiveRtp.subscribe(() => packets++));
  await pc.setLocalDescription(await pc.createOffer());
  if (pc.iceGatheringState !== 'complete') await new Promise<void>((r) => pc.iceGatheringStateChange.subscribe((s) => s === 'complete' && r()));
  let ended = 0;
  const server = await answer(pc.localDescription?.sdp ?? '', clip(), () => ended++, silenceMs);
  await pc.setRemoteDescription({ type: 'answer', sdp: server.sdp });
  return { pc, server, packets: () => packets, ended: () => ended };
}

/** A DTLS close_notify alert (level warning, description 0) on the peer's DTLS session, encrypted as its records are. */
async function sendCloseNotify(pc: RTCPeerConnection): Promise<void> {
  type Socket = { dtls: { recordSequenceNumber: number }; cipher: { encryptPacket(p: unknown): { serialize(): Buffer } }; transport: { send(b: Buffer): Promise<void> } };
  const { createPlaintext } = (req(req.resolve('werift').replace(/lib[\\/].*$/, 'lib/dtls/src/record/builder.js'))) as unknown as { createPlaintext: (d: unknown) => (f: { type: number; fragment: Buffer }[], seq: number) => unknown[] };
  for (const t of pc.dtlsTransports) {
    const socket = (t as unknown as { dtls?: Socket }).dtls;
    if (socket === undefined) continue;
    const record = createPlaintext(socket.dtls)([{ type: 21, fragment: Buffer.from([1, 0]) }], ++socket.dtls.recordSequenceNumber)[0];
    await socket.transport.send(socket.cipher.encryptPacket(record).serialize());
  }
}

describe('WHEP fixture sessions', () => {
  it('stop sending within 1 s when the receiver closes without a DELETE (close is then a no-op)', async () => {
    const r = await receiver();
    await expect.poll(() => r.packets(), { timeout: 10_000 }).toBeGreaterThan(20);
    // A browser closing the page ends DTLS with a close_notify alert; werift's close() does not
    // send one, so the stand-in does it (one alert record on its DTLS session). The alert is UDP:
    // closing the receiver's socket right after can drop it on a busy machine (CI f10779c), so the
    // receiver closes once the sender has stopped, as a page's process outlives its last packets.
    const at = Date.now();
    await sendCloseNotify(r.pc);
    await expect.poll(() => r.ended(), { timeout: 2000 }).toBe(1);
    expect(Date.now() - at).toBeLessThanOrEqual(1000);
    await r.pc.close();
    r.server.close();
    expect(r.ended()).toBe(1);
  }, 20_000);

  it('stop after the silence limit when the receiver stays connected but sends no RTCP', async () => {
    const r = await receiver(1500);
    await expect.poll(() => r.packets(), { timeout: 10_000 }).toBeGreaterThan(20);
    // The receiver goes quiet (its RTCP reports stop) without leaving: a frozen tab.
    for (const t of r.pc.getTransceivers()) t.receiver.stop();
    await expect.poll(() => r.ended(), { timeout: 5000 }).toBe(1);
    await r.pc.close();
  }, 30_000);
});
