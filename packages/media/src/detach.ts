// Async engine teardown must finish before another backend reuses the same element.
const pending = new WeakMap<HTMLMediaElement, Promise<void>>();

/** Records engine teardown on an element so its next backend can wait before attaching a source. */
export function trackMediaDetach(media: HTMLMediaElement, operation: Promise<unknown>): void {
  const previous = pending.get(media);
  const settled = operation.then(() => undefined, () => undefined);
  const next = previous === undefined ? settled : Promise.all([previous, settled]).then(() => undefined);
  pending.set(media, next);
  void next.then(() => {
    if (pending.get(media) === next) pending.delete(media);
  });
}

/** Pending teardown of the previous engine, or undefined when the element can be reused at once. */
export function waitForMediaDetach(media: HTMLMediaElement): Promise<void> | undefined {
  return pending.get(media);
}
