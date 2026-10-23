// Frames a Decoder hands out (SPEC §6.3, ADR-008 §3). WebCodecs decoders produce VideoFrame /
// AudioData; WASM decoders produce planar I420 pictures. Both are transferable (postMessage), so
// the decode pool can move them to the rendering side without copying pixels.

/** Planar 4:2:0 picture: Y (width x height), then U and V (half size, rounded up). */
export interface I420Frame {
  readonly format: 'I420';
  readonly width: number;
  readonly height: number;
  /** Y plane, U plane, V plane back to back (see i420Size). */
  readonly data: Uint8Array;
  /** Microseconds, like VideoFrame. */
  readonly timestamp: number;
  /** YUV -> RGB coefficients; default from the picture height (BT.709 from 720 lines up). */
  readonly matrix?: 'bt601' | 'bt709';
  /** true for full range (JPEG) pictures, false / absent for limited range (MPEG). */
  readonly fullRange?: boolean;  /** Colour primaries; default from the matrix (BT.601: SMPTE 170M, BT.709: BT.709). */
  readonly primaries?: 'bt709' | 'bt470bg' | 'smpte170m';
}

/** A decoded picture or audio block. */
export type DecodedFrame = VideoFrame | AudioData | I420Frame;

export const isI420 = (f: DecodedFrame): f is I420Frame =>
  (f as Partial<I420Frame>).format === 'I420' && (f as Partial<I420Frame>).data instanceof Uint8Array;

/** Bytes of an I420 picture with the given size. */
export const i420Size = (width: number, height: number): number => {
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  return width * height + 2 * cw * ch;
};

/** Objects to pass in postMessage's transfer list for `frame` (nothing is cloned). */
export function frameTransferables(frame: DecodedFrame): Transferable[] {
  if (isI420(frame)) return [frame.data.buffer as ArrayBuffer];
  const close = typeof (frame as VideoFrame).close === 'function';
  // VideoFrame and AudioData are themselves transferable.
  return close ? [frame as VideoFrame] : [];
}

/** Releases the frame's resources (idempotent). */
export function closeFrame(frame: DecodedFrame | undefined): void {
  if (frame === undefined || isI420(frame)) return;
  const f = frame as VideoFrame & AudioData;
  if (typeof f.close === 'function') f.close();
}

/**
 * Where a frame-producing backend puts pictures (ADR-008 §6): the render layer's FrameSurface
 * (GPUSurface / CanvasSurface) satisfies it. Engine packages depend on this, never on surface.
 */
export interface FrameSink {
  /** Shows `frame` from the next paint; takes ownership of VideoFrames. */
  draw(frame: VideoFrame | I420Frame): void;
  /** Back to no picture. */
  clear(): void;
}
