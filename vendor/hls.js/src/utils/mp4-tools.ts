// Derived from hls.js@b023c2908c53b8cbe25665de4df9713cd3bbfdbf src/utils/mp4-tools.ts, Apache-2.0
// Subset: box type table, track ids, uint read / write, appendUint8Array and the SEI parser used by
// the video parsers. @svta/cml-id3's utf8ArrayToStr is replaced by TextDecoder.
import { utf8Decode } from '../otter/env.js';
import { logger } from '../otter/shims.js';
import type { UserdataSample } from '../types/demuxer.js';

const utf8 = (data: Uint8Array): string => utf8Decode(data);

export const UINT32_MAX = Math.pow(2, 32) - 1;

export const types = {
  avc1: 0x61766331,
  avcC: 0x61766343,
  hvc1: 0x68766331,
  hvcC: 0x68766343,
  btrt: 0x62747274,
  dinf: 0x64696e66,
  dref: 0x64726566,
  esds: 0x65736473,
  free: 0x66726565,
  ftyp: 0x66747970,
  hdlr: 0x68646c72,
  mdat: 0x6d646174,
  mdhd: 0x6d646864,
  mdia: 0x6d646961,
  mfhd: 0x6d666864,
  minf: 0x6d696e66,
  moof: 0x6d6f6f66,
  moov: 0x6d6f6f76,
  mp4a: 0x6d703461,
  '.mp3': 0x2e6d7033,
  dac3: 0x64616333,
  'ac-3': 0x61632d33,
  mvex: 0x6d766578,
  mvhd: 0x6d766864,
  pasp: 0x70617370,
  sdtp: 0x73647470,
  stbl: 0x7374626c,
  stco: 0x7374636f,
  stsc: 0x73747363,
  stsd: 0x73747364,
  stsz: 0x7374737a,
  stts: 0x73747473,
  tfdt: 0x74666474,
  tfhd: 0x74666864,
  traf: 0x74726166,
  trak: 0x7472616b,
  trun: 0x7472756e,
  trex: 0x74726578,
  tkhd: 0x746b6864,
  vmhd: 0x766d6864,
  smhd: 0x736d6864,
} as const;


// We are using fixed track IDs for driving the MP4 remuxer
// instead of following the TS PIDs.
// There is no reason not to do this and some browsers/SourceBuffer-demuxers
// may not like if there are TrackID "switches"
// See https://github.com/video-dev/hls.js/issues/1331
// Here we are mapping our internal track types to constant MP4 track IDs
// With MSE currently one can only have one track of each, and we are muxing
// whatever video/audio rendition in them.
export const RemuxerTrackIdConfig = {
  video: 1,
  audio: 2,
  id3: 3,
  text: 4,
};


function readUint16(buffer: Uint8Array, offset: number): number {
  const val = (buffer[offset]! << 8) | buffer[offset + 1]!;
  return val < 0 ? 65536 + val : val;
}

function readUint32(buffer: Uint8Array, offset: number): number {
  const val =
    (buffer[offset]! << 24) |
    (buffer[offset + 1]! << 16) |
    (buffer[offset + 2]! << 8) |
    buffer[offset + 3]!;
  return val < 0 ? 4294967296 + val : val;
}

export function writeUint32(buffer: Uint8Array, offset: number, value: number) {
  buffer[offset] = value >> 24;
  buffer[offset + 1] = (value >> 16) & 0xff;
  buffer[offset + 2] = (value >> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

function decodeUtf8UserData(data: Uint8Array): string {
  const result = utf8(data);
  return result.replace(/\0/g, '');
}

export function appendUint8Array(data1: Uint8Array, data2: Uint8Array) {
  const temp = new Uint8Array(data1.length + data2.length);
  temp.set(data1);
  temp.set(data2, data1.length);
  return temp;
}

export function parseSEIMessageFromNALu(
  unescapedData: Uint8Array,
  headerSize: number,
  pts: number,
  samples: UserdataSample[],
) {
  const data = discardEPB(unescapedData);
  let seiPtr = 0;
  // skip nal header
  seiPtr += headerSize;
  let payloadType = 0;
  let payloadSize = 0;
  let b = 0;

  while (seiPtr < data.length) {
    payloadType = 0;
    do {
      if (seiPtr >= data.length) {
        break;
      }
      b = data[seiPtr++]!;
      payloadType += b;
    } while (b === 0xff);

    // Parse payload size.
    payloadSize = 0;
    do {
      if (seiPtr >= data.length) {
        break;
      }
      b = data[seiPtr++]!;
      payloadSize += b;
    } while (b === 0xff);

    const leftOver = data.length - seiPtr;
    // Create a variable to process the payload
    let payPtr = seiPtr;

    // Increment the seiPtr to the end of the payload
    if (payloadSize < leftOver) {
      seiPtr += payloadSize;
    } else if (payloadSize > leftOver) {
      // Some type of corruption has happened?
      logger.error(
        `Malformed SEI payload. ${payloadSize} is too small, only ${leftOver} bytes left to parse.`,
      );
      // We might be able to parse some data, but let's be safe and ignore it.
      break;
    }

    if (payloadType === 4) {
      const countryCode = data[payPtr++];
      if (countryCode === 181) {
        const providerCode = readUint16(data, payPtr);
        payPtr += 2;

        if (providerCode === 49) {
          const userStructure = readUint32(data, payPtr);
          payPtr += 4;

          if (userStructure === 0x47413934) {
            const userDataType = data[payPtr++];

            // Raw CEA-608 bytes wrapped in CEA-708 packet
            if (userDataType === 3) {
              const firstByte = data[payPtr++]!;
              const totalCCs = 0x1f & firstByte;
              const enabled = 0x40 & firstByte;
              const totalBytes = enabled ? 2 + totalCCs * 3 : 0;
              const byteArray = new Uint8Array(totalBytes);
              if (enabled) {
                byteArray[0] = firstByte;
                for (let i = 1; i < totalBytes; i++) {
                  byteArray[i] = data[payPtr++]!;
                }
              }

              samples.push({
                type: userDataType,
                payloadType,
                pts,
                bytes: byteArray,
              });
            }
          }
        }
      }
    } else if (payloadType === 5) {
      if (payloadSize > 16) {
        const uuidStrArray: Array<string> = [];
        for (let i = 0; i < 16; i++) {
          const b = data[payPtr++]!.toString(16);
          uuidStrArray.push(b.length == 1 ? '0' + b : b);

          if (i === 3 || i === 5 || i === 7 || i === 9) {
            uuidStrArray.push('-');
          }
        }
        const length = payloadSize - 16;
        const userDataBytes = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
          userDataBytes[i] = data[payPtr++]!;
        }

        samples.push({
          payloadType,
          pts,
          uuid: uuidStrArray.join(''),
          userData: decodeUtf8UserData(userDataBytes),
          userDataBytes,
        });
      }
    }
  }
}

export function discardEPB(data: Uint8Array): Uint8Array {
  const length = data.byteLength;
  let epbPositions: number[] | undefined;
  let position = data.indexOf(0x03, 3);

  // Find all `Emulation Prevention Bytes`
  while (position !== -1) {
    if (data[position - 1] === 0 && data[position - 2] === 0) {
      (epbPositions ||= []).push(position);
    }
    position = data.indexOf(0x03, position + 1);
  }

  // If no Emulation Prevention Bytes were found just return the original
  // array
  if (!epbPositions) {
    return data;
  }

  // Create a new array to hold the NAL unit data
  const newLength = length - epbPositions.length;
  const newData = new Uint8Array(newLength);
  let epbIndex = 0;
  let sourceIndex = 0;

  for (let i = 0; i < newLength; sourceIndex++, i++) {
    if (sourceIndex === epbPositions[epbIndex]) {
      // Skip this byte
      sourceIndex++;
      epbIndex++;
    }
    newData[i] = data[sourceIndex]!;
  }
  return newData;
}
