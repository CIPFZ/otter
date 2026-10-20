// Worker side of the WebCodecs decoder for @otter-player/decoder-pool: a self-contained function
// expression (the pool loads its source into a Worker), so no imports and no outer references.
// VideoFrames go back transferred.

/* eslint-disable */
export const webCodecsWorker: (env: unknown) => unknown = (_env) => ({
  create(config: { codec: string; codedWidth?: number; codedHeight?: number; description?: ArrayBuffer; colorSpace?: VideoColorSpaceInit; hardwareAcceleration?: HardwareAcceleration }, out: { frame(f: unknown): void; error(details: string, message: string): void; queue(n: number): void }) {
    let failed = false;
    const decoder = new VideoDecoder({
      output: (frame) => out.frame(frame),
      error: (e) => {
        if (failed) return;
        failed = true;
        out.error(e.name === 'NotSupportedError' ? 'decoderUnsupported' : 'decodeError', `${e.name}: ${e.message}`);
      },
    });
    decoder.addEventListener('dequeue', () => out.queue(decoder.decodeQueueSize));
    const configure = (): void =>
      decoder.configure({
        codec: config.codec,
        ...(config.codedWidth === undefined ? {} : { codedWidth: config.codedWidth }),
        ...(config.codedHeight === undefined ? {} : { codedHeight: config.codedHeight }),
        ...(config.description === undefined ? {} : { description: config.description }),
        ...(config.colorSpace === undefined ? {} : { colorSpace: config.colorSpace }),
        hardwareAcceleration: config.hardwareAcceleration ?? 'no-preference',
      });
    configure();
    return {
      get queue() {
        return decoder.decodeQueueSize;
      },
      decode(c: { type: 'key' | 'delta'; timestamp: number; duration?: number; data: ArrayBuffer }) {
        if (decoder.state !== 'configured') return;
        decoder.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.timestamp, ...(c.duration === undefined ? {} : { duration: c.duration }), data: c.data }));
      },
      flush: () => (decoder.state === 'configured' ? decoder.flush() : undefined),
      reset() {
        if (decoder.state === 'closed') return;
        decoder.reset();
        configure();
      },
      close() {
        if (decoder.state !== 'closed') decoder.close();
      },
    };
  },
});
