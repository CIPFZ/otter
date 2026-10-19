// Derived from hls.js@b023c2908c53b8cbe25665de4df9713cd3bbfdbf src/utils/numeric-encoding-utils.ts, Apache-2.0
import { base64ToBinary } from '../otter/env.js';
export function base64Decode(base64encodedStr: string): Uint8Array {
  return Uint8Array.from(base64ToBinary(base64encodedStr), (c: string) => c.charCodeAt(0));
}

export function bin2str(data: number[] | Uint8Array | Uint16Array): string {
  return String.fromCharCode.apply(null, Array.from(data));
}
