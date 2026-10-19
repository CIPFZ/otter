// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/utils/numeric-encoding-utils.ts, Apache-2.0
import { base64ToBinary } from '../otter/env.js';
export function base64Decode(base64encodedStr: string): Uint8Array {
  return Uint8Array.from(base64ToBinary(base64encodedStr), (c: string) => c.charCodeAt(0));
}

export function bin2str(data: number[] | Uint8Array | Uint16Array): string {
  return String.fromCharCode.apply(null, Array.from(data));
}
