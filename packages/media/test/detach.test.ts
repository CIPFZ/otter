// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { trackMediaDetach, waitForMediaDetach } from '@otter-player/media';

it('keeps every pending detach until the newest combined barrier settles', async () => {
  const media = document.createElement('video');
  expect(waitForMediaDetach(media)).toBeUndefined();
  let first: (() => void) | undefined;
  let second: (() => void) | undefined;
  trackMediaDetach(media, new Promise<void>((resolve) => { first = resolve; }));
  trackMediaDetach(media, new Promise<void>((resolve) => { second = resolve; }));
  const waiting = waitForMediaDetach(media);
  let done = false;
  void waiting?.then(() => { done = true; });
  first?.();
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  expect(waitForMediaDetach(media)).toBe(waiting);
  second?.();
  await waiting;
  await Promise.resolve();
  expect(waitForMediaDetach(media)).toBeUndefined();
});

it('allows reuse after a detach rejects', async () => {
  const media = document.createElement('video');
  trackMediaDetach(media, Promise.reject(new Error('detach failed')));
  await waitForMediaDetach(media);
  await Promise.resolve();
  expect(waitForMediaDetach(media)).toBeUndefined();
});
