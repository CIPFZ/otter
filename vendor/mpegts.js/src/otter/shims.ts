// Otter shims for the mpegts.js modules the vendored FLV demuxer imported (ADR-007 §1): logger and
// exceptions. Same names and shapes as upstream, Otter's own code.

type LogFn = (tag: string, msg: string) => void;
const noop: LogFn = () => undefined;

/** mpegts.js utils/logger.js subset; silent unless the pipeline installs a sink. */
const Log: { e: LogFn; w: LogFn; i: LogFn; v: LogFn; d: LogFn } = { e: noop, w: noop, i: noop, v: noop, d: noop };
export default Log;

class RuntimeException extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class IllegalStateException extends RuntimeException {}
export class InvalidArgumentException extends RuntimeException {}
