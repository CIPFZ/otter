const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read only npm's structured error code; diagnostic text cannot establish that a package is absent. */
export function npmErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.stdout !== 'string') return undefined;
  let result: unknown;
  try {
    result = JSON.parse(error.stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(result) || !isRecord(result.error)) return undefined;
  return typeof result.error.code === 'string' ? result.error.code : undefined;
}
