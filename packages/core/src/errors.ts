// Unified error model (SPEC §4). Categories mirror hls.js ErrorTypes so engine errors map 1:1.

export type OtterErrorType = 'network' | 'media' | 'drm' | 'mux' | 'other';

export interface OtterError {
  readonly type: OtterErrorType;
  /** Stable machine-readable code, e.g. `manifestLoadError`, `notImplemented`. */
  readonly details: string;
  readonly fatal: boolean;
  readonly recoverable: boolean;
  readonly cause?: unknown;
}

export interface OtterErrorInit extends OtterError {
  /** Human-readable message for logs; not part of the stable model. */
  readonly message?: string;
}

class OtterErrorImpl extends Error implements OtterError {
  readonly type: OtterErrorType;
  readonly details: string;
  readonly fatal: boolean;
  readonly recoverable: boolean;

  constructor(init: OtterErrorInit) {
    super(init.message ?? init.details, 'cause' in init ? { cause: init.cause } : undefined);
    this.name = 'OtterError';
    this.type = init.type;
    this.details = init.details;
    this.fatal = init.fatal;
    this.recoverable = init.recoverable;
  }
}

/** Creates a throwable error that also satisfies the {@link OtterError} model. */
export function createError(init: OtterErrorInit): OtterError & Error {
  return new OtterErrorImpl(init);
}

export function isOtterError(value: unknown): value is OtterError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof OtterError, unknown>>;
  return (
    typeof v.type === 'string' &&
    typeof v.details === 'string' &&
    typeof v.fatal === 'boolean' &&
    typeof v.recoverable === 'boolean'
  );
}

/** Uniform error for M0 empty implementations. Non-fatal: callers fall back to another path. */
export function notImplemented(what: string): OtterError & Error {
  return createError({
    type: 'other',
    details: 'notImplemented',
    fatal: false,
    recoverable: false,
    message: `${what} is not implemented yet`,
  });
}
