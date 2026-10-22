// Own CMAF-HLS engine pieces that need no browser: what it leaves to hls.js (ADR-010 §2) and the
// WebVTT segment parser (cue placement on the media timeline).
import { describe, expect, it } from 'vitest';
import { unsupportedIn } from '../src/own/engine.js';
import { parseVttSegment, vttTime } from '../src/own/subtitles.js';

const media = (body: string): string => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n${body}\n#EXTINF:2,\ns0.m4s\n#EXT-X-ENDLIST\n`;

describe('unsupportedIn', () => {
  it('names the tag of each class it leaves to hls.js', () => {
    expect(unsupportedIn(media(''), false)).toBeUndefined();
    expect(unsupportedIn(media('#EXT-X-DISCONTINUITY'), false)).toBe('EXT-X-DISCONTINUITY');
    expect(unsupportedIn(media('#EXT-X-DISCONTINUITY-SEQUENCE:3'), false)).toBeUndefined();
    expect(unsupportedIn(media('#EXT-X-KEY:METHOD=AES-128,URI="k"'), false)).toBe('EXT-X-KEY');
    expect(unsupportedIn(media('#EXT-X-KEY:METHOD=NONE'), false)).toBeUndefined();
    expect(unsupportedIn(media('#EXT-X-PART-INF:PART-TARGET=1'), false)).toBe('EXT-X-PART-INF');
    expect(unsupportedIn(media('#EXT-X-SERVER-CONTROL:PART-HOLD-BACK=3'), false)).toBe('EXT-X-PART');
    expect(unsupportedIn(media('#EXT-X-SERVER-CONTROL:HOLD-BACK=6'), false)).toBeUndefined();
    expect(unsupportedIn('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg0.ts\n', false)).toBe('TS segments');
    expect(unsupportedIn('#EXTM3U\n#EXTINF:6,\nseg0.mp4\n', false)).toBe('no EXT-X-MAP');
    // Subtitle playlists have no init segment.
    expect(unsupportedIn('#EXTM3U\n#EXTINF:6,\nsubs.vtt\n', false, true)).toBeUndefined();
  });

  it('in the multivariant playlist: I-frame playlists, session keys, closed captions', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.42c01e"\nv.m3u8\n';
    expect(unsupportedIn(master, true)).toBeUndefined();
    expect(unsupportedIn(`${master}#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="i.m3u8"\n`, true)).toBe('EXT-X-I-FRAME-STREAM-INF');
    expect(unsupportedIn(`${master}#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n`, true)).toBe('EXT-X-SESSION-KEY');
    expect(unsupportedIn(`#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",INSTREAM-ID="CC1"\n${master}`, true)).toBe('CLOSED-CAPTIONS');
  });
});

describe('parseVttSegment', () => {
  it('reads timestamps with and without hours', () => {
    expect(vttTime('00:01.500')).toBe(1.5);
    expect(vttTime('01:00:02.250')).toBe(3602.25);
    expect(Number.isNaN(vttTime('nope'))).toBe(true);
  });

  it('maps cues through X-TIMESTAMP-MAP (MPEGTS on the media clock), else adds the playlist offset', () => {
    const mapped = parseVttSegment('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:126000,LOCAL:00:00:00.000\n\n00:00.500 --> 00:03.500\nOne\n', 9);
    expect(mapped).toEqual([{ id: '1.900-4.900-One', startTime: 1.9, endTime: 4.9, text: 'One' }]);
    const plain = parseVttSegment('WEBVTT\n\n1\n00:00:10.000 --> 00:00:12.000 line:80% align:start\n<i>Two</i> &amp; three\n', 0.5);
    expect(plain).toEqual([{ id: '10.500-12.500-Two & three', startTime: 10.5, endTime: 12.5, text: 'Two & three', line: 80, snapToLines: false, align: 'start' }]);
  });

  it('skips malformed and empty cues', () => {
    expect(parseVttSegment('WEBVTT\n\nxx --> yy\nBad\n\n00:01.000 --> 00:02.000\n\n', 0)).toEqual([]);
  });
});
