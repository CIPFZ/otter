// Derived from hls.js@e5ff3583965e3af16c4a4b4d2b5f7bd1ffb5b7de src/utils/numeric-encoding-utils.ts, Apache-2.0
export function base64Decode(base64encodedStr: string): Uint8Array {
  return Uint8Array.from(atob(base64encodedStr), (c) => c.charCodeAt(0));
}

export function bin2str(data: number[] | Uint8Array | Uint16Array): string {
  return String.fromCharCode.apply(null, Array.from(data));
}
