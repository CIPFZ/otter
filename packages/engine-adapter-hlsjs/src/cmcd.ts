// CMCD for hls.js (ADR-005 §2): fLoader / pLoader subclasses of the configured loader that
// rewrite context.url (query mode) or add context.headers (headers mode) from the Otter
// decorator, so hls.js sends the same keys as Shaka and mpegts.js. hls.js' own CMCD stays off.

import type { CmcdDecorator, CmcdObjectKind, CmcdRequestInfo } from '@otter-player/media';
import type Hls from 'hls.js';
import type {
  FragmentLoaderConstructor,
  FragmentLoaderContext,
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  PlaylistLoaderConstructor,
} from 'hls.js';

type LoaderCtor = new (config: HlsConfig) => Loader<LoaderContext>;

/** CMCD request description of an hls.js fragment request. */
export function fragmentRequest(context: FragmentLoaderContext, hls: Pick<Hls, 'levels'>): CmcdRequestInfo {
  const { frag, part } = context;
  let kind: CmcdObjectKind;
  if (frag.sn === 'initSegment') {
    kind = 'init';
  } else if (frag.type === 'audio') {
    kind = 'audio';
  } else if (frag.type === 'subtitle') {
    kind = 'caption';
  } else {
    const level = hls.levels[frag.level];
    kind = level?.audioCodec !== undefined && level.videoCodec !== undefined ? 'muxed' : 'video';
  }
  const bitrate = frag.type === 'main' ? hls.levels[frag.level]?.bitrate : undefined;
  const duration = (part ?? frag).duration;
  return {
    url: context.url,
    kind,
    ...(kind !== 'init' && duration > 0 ? { durationS: duration } : {}),
    ...(bitrate === undefined ? {} : { bitrateBps: bitrate }),
  };
}

const apply = (context: LoaderContext, decoration: { url: string; headers: Readonly<Record<string, string>> }): void => {
  context.url = decoration.url;
  if (Object.keys(decoration.headers).length > 0) context.headers = { ...context.headers, ...decoration.headers };
};

/** fLoader / pLoader config entries for `new Hls({...})`. `hls()` resolves the instance lazily. */
export function cmcdLoaders(
  Base: LoaderCtor,
  cmcd: CmcdDecorator,
  hls: () => Hls | undefined,
): { fLoader: FragmentLoaderConstructor; pLoader: PlaylistLoaderConstructor } {
  class CmcdFragmentLoader extends Base {
    override load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      const instance = hls();
      if (instance !== undefined) apply(context, cmcd.decorate(fragmentRequest(context as FragmentLoaderContext, instance)));
      super.load(context, config, callbacks);
    }
  }
  class CmcdPlaylistLoader extends Base {
    override load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>): void {
      apply(context, cmcd.decorate({ url: context.url, kind: 'manifest' }));
      super.load(context, config, callbacks);
    }
  }
  // Same loader class for both roles; hls.js narrows the context type per role.
  return {
    fLoader: CmcdFragmentLoader as unknown as FragmentLoaderConstructor,
    pLoader: CmcdPlaylistLoader as unknown as PlaylistLoaderConstructor,
  };
}
