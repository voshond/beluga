/**
 * Previews for Beluga in a browser or the app as a client (docs/previews.md, From another computer):
 * the preview server reached at an origin of its own (a host name a proxy sends to it), never the
 * web port's, so a component's code can't reach Beluga's session. Off unless both are set:
 *   BELUGA_PREVIEW_ORIGIN    the origin frames load from, e.g. https://preview.example.com
 *   BELUGA_PREVIEW_FRAMED_BY the web port's origins that may frame it, e.g. https://beluga.example.com
 *   BELUGA_PREVIEW_LISTEN    where the preview server listens then (default 0.0.0.0: the proxy reaches it)
 */

export interface PreviewPublic {
  readonly origin: string;
  readonly host: string;
  readonly framedBy: readonly string[];
  readonly listen: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const originOf = (value: string): string | undefined => {
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    if (u.pathname !== '/' || u.search || u.hash || u.username) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
};

/** The public preview origin, when it's set up (both variables valid), else undefined. */
export function previewPublic(env: Env = process.env): PreviewPublic | undefined {
  const origin = env.BELUGA_PREVIEW_ORIGIN ? originOf(env.BELUGA_PREVIEW_ORIGIN) : undefined;
  if (!origin) return undefined;
  const framedBy = (env.BELUGA_PREVIEW_FRAMED_BY ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(originOf)
    .filter((o): o is string => Boolean(o) && o !== origin);
  if (!framedBy.length) return undefined;
  return { origin, host: new URL(origin).hostname, framedBy, listen: env.BELUGA_PREVIEW_LISTEN?.trim() || '0.0.0.0' };
}
