// Minimal local WHEP endpoint for the e2e matrix (format-whep, SPEC §19 "国内直播"): POST an SDP
// offer to /whep/live, get 201 + an SDP answer + a Location; a werift peer (pure TypeScript
// WebRTC, dev dependency only) then sends e2e/media/whep/clip.ivf (VP8, looped, real-time paced)
// as RTP, and e2e/media/whep/tone.ogg (Opus, 440 Hz) on the audio track when the offer has one.
// DELETE on the Location ends the session. /whep/ice-fail answers with an unreachable
// candidate only, so the client's ICE never connects (the fallback path). /whep/reject answers 503.

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from 'werift';

interface IvfFrame {
  readonly data: Buffer;
  readonly key: boolean;
}

/** IVF: 32-byte file header, then per frame a 12-byte header (size, 64-bit pts) and the frame. */
export function parseIvf(file: Buffer): { fps: number; frames: IvfFrame[] } {
  if (file.toString('latin1', 0, 4) !== 'DKIF') throw new Error('not an IVF file');
  const rate = file.readUInt32LE(16);
  const scale = file.readUInt32LE(20);
  const frames: IvfFrame[] = [];
  let pos = file.readUInt16LE(6);
  while (pos + 12 <= file.length) {
    const size = file.readUInt32LE(pos);
    const data = file.subarray(pos + 12, pos + 12 + size);
    // VP8 frame tag: bit 0 of the first byte is 0 for a key frame.
    frames.push({ data, key: ((data[0] as number) & 1) === 0 });
    pos += 12 + size;
  }
  return { fps: rate / scale, frames };
}

/** Opus packets of an Ogg file, without the OpusHead / OpusTags header packets. */
export function parseOggOpus(file: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let partial: Buffer[] = [];
  let pos = 0;
  while (pos + 27 <= file.length && file.toString('latin1', pos, pos + 4) === 'OggS') {
    const segments = file.readUInt8(pos + 26);
    const table = file.subarray(pos + 27, pos + 27 + segments);
    let at = pos + 27 + segments;
    for (const lace of table) {
      partial.push(file.subarray(at, at + lace));
      at += lace;
      // A lacing value below 255 ends a packet.
      if (lace < 255) {
        packets.push(Buffer.concat(partial));
        partial = [];
      }
    }
    pos = at;
  }
  return packets.slice(2);
}

interface Clip {
  readonly fps: number;
  readonly frames: IvfFrame[];
  /** 20 ms Opus packets. */
  readonly opus: Buffer[];
}

const MTU_PAYLOAD = 1100;

/** RFC 7741 VP8 payloads: a one-byte descriptor (S on the first packet of the frame, PID 0). */
export function packetizeVp8(frame: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < frame.length; at += MTU_PAYLOAD) {
    out.push(Buffer.concat([Buffer.from([at === 0 ? 0x10 : 0x00]), frame.subarray(at, at + MTU_PAYLOAD)]));
  }
  return out;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

const sessions = new Map<string, () => void>();
let nextId = 0;

/** Sends the clip in a loop on `track`, paced at its frame rate, with continuing RTP timestamps. */
function play(track: MediaStreamTrack, clip: Clip): () => void {
  let seq = Math.floor(Math.random() * 0xffff);
  let n = 0;
  const step = Math.round(90_000 / clip.fps);
  const started = Date.now();
  const pump = (): void => {
    const due = Math.floor(((Date.now() - started) / 1000) * clip.fps);
    for (; n <= due; n++) {
      const frame = clip.frames[n % clip.frames.length] as IvfFrame;
      const payloads = packetizeVp8(frame.data);
      payloads.forEach((payload, i) => {
        const header = new RtpHeader({ payloadType: 96, sequenceNumber: seq, timestamp: (n * step) >>> 0, marker: i === payloads.length - 1 });
        seq = (seq + 1) & 0xffff;
        track.writeRtp(new RtpPacket(header, payload));
      });
    }
  };
  const timer = setInterval(pump, 1000 / clip.fps / 2);
  return () => clearInterval(timer);
}

/** Sends the Opus packets in a loop on `track`, one per 20 ms (960 samples at 48 kHz). */
function playAudio(track: MediaStreamTrack, opus: Buffer[]): () => void {
  let seq = Math.floor(Math.random() * 0xffff);
  let n = 0;
  const started = Date.now();
  const pump = (): void => {
    const due = Math.floor((Date.now() - started) / 20);
    for (; n <= due; n++) {
      const header = new RtpHeader({ payloadType: 111, sequenceNumber: seq, timestamp: (n * 960) >>> 0, marker: n === 0 });
      seq = (seq + 1) & 0xffff;
      track.writeRtp(new RtpPacket(header, opus[n % opus.length] as Buffer));
    }
  };
  const timer = setInterval(pump, 10);
  return () => clearInterval(timer);
}

async function answer(offer: string, clip: Clip): Promise<{ sdp: string; close: () => void }> {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [new RTCRtpCodecParameters({ mimeType: 'video/VP8', clockRate: 90_000 })],
      audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48_000, channels: 2 })],
    },
    iceAdditionalHostAddresses: ['127.0.0.1'],
    // Host candidates only: no public STUN lookups from the test machine.
    iceServers: [],
  });
  await pc.setRemoteDescription({ type: 'offer', sdp: offer });
  const track = new MediaStreamTrack({ kind: 'video' });
  const video = pc.getTransceivers().find((t) => t.kind === 'video');
  if (video === undefined) throw new Error('offer has no video');
  video.setDirection('sendonly');
  video.sender.replaceTrack(track);
  const sound = new MediaStreamTrack({ kind: 'audio' });
  const audio = pc.getTransceivers().find((t) => t.kind === 'audio');
  if (audio !== undefined) {
    audio.setDirection('sendonly');
    audio.sender.replaceTrack(sound);
  }
  await pc.setLocalDescription(await pc.createAnswer());
  // Non-trickle: the answer carries every candidate.
  if (pc.iceGatheringState !== 'complete') await new Promise<void>((r) => pc.iceGatheringStateChange.subscribe((s) => s === 'complete' && r()));
  let stop: (() => void) | undefined;
  pc.connectionStateChange.subscribe((s) => {
    if (s !== 'connected' || stop !== undefined) return;
    const stops = [play(track, clip), ...(audio === undefined ? [] : [playAudio(sound, clip.opus)])];
    stop = () => stops.forEach((f) => f());
  });
  return {
    sdp: pc.localDescription?.sdp ?? '',
    close: () => {
      stop?.();
      void pc.close();
    },
  };
}

/** The answer with every candidate replaced by one nobody answers (TEST-NET-1, RFC 5737). */
const unreachable = (sdp: string): string =>
  sdp
    .split('\r\n')
    .filter((l) => !l.startsWith('a=candidate:') && l !== 'a=end-of-candidates')
    .flatMap((l) => (l.startsWith('a=mid:') ? [l, 'a=candidate:1 1 udp 2130706431 192.0.2.1 9 typ host', 'a=end-of-candidates'] : [l]))
    .join('\r\n');

async function handle(req: IncomingMessage, res: ServerResponse, clip: () => Clip): Promise<void> {
  const path = req.url?.split('?')[0] ?? '';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Location');
  if (req.method === 'DELETE') {
    sessions.get(path)?.();
    sessions.delete(path);
    res.writeHead(200).end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  if (path === '/whep/reject') {
    res.writeHead(503, { 'Content-Type': 'text/plain' }).end('no stream');
    return;
  }
  if (req.headers['content-type'] !== 'application/sdp') {
    res.writeHead(415).end();
    return;
  }
  const offer = await readBody(req);
  const { sdp, close } = await answer(offer, clip());
  const location = `/whep/session/${++nextId}`;
  if (path === '/whep/ice-fail') close();
  else sessions.set(location, close);
  res.writeHead(201, { 'Content-Type': 'application/sdp', Location: location }).end(path === '/whep/ice-fail' ? unreachable(sdp) : sdp);
}

export function whepPlugin(file: string): Plugin {
  let clip: Clip | undefined;
  const load = (): Clip => (clip ??= { ...parseIvf(readFileSync(file)), opus: parseOggOpus(readFileSync(file.replace(/clip\.ivf$/, 'tone.ogg'))) });
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!(req.url ?? '').startsWith('/whep/')) {
      next();
      return;
    }
    handle(req, res, load).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(err));
    });
  };
  return {
    name: 'otter-whep',
    configureServer: (server) => {
      server.middlewares.use(middleware);
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(middleware);
    },
  };
}
