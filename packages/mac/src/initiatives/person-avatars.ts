import { useEffect, useState } from 'react';
import { useApi, useApp } from '../lib/beluga.js';

type Api = ReturnType<typeof useApi>;

/**
 * Directory people's pictures (core/initiatives/people-avatars.ts): the state says each one's
 * checksum, the bytes come once through initiatives.personAvatar and stay here as data URLs.
 */
const urls = new Map<string, string>();
const loading = new Map<string, Promise<string | undefined>>();

const loadPicture = (api: Api, sha: string): Promise<string | undefined> => {
  const have = urls.get(sha);
  if (have) return Promise.resolve(have);
  const pending = loading.get(sha);
  if (pending) return pending;
  const load = api.initiatives.personAvatar(sha).then(
    (p) => {
      if (!p) return undefined;
      const data = `data:${p.mime};base64,${p.b64}`;
      urls.set(sha, data);
      return data;
    },
    () => undefined,
  );
  void load.finally(() => loading.delete(sha));
  loading.set(sha, load);
  return load;
};

/** A directory person's picture as a URL to draw, once it's here (undefined: show their initial). */
export const usePersonPicture = (slug: string): string | undefined => {
  const api = useApi();
  const sha = useApp((st) => st.initiatives.avatars?.[slug]);
  const [url, setUrl] = useState(() => (sha ? urls.get(sha) : undefined));
  useEffect(() => {
    if (!sha) return setUrl(undefined);
    const have = urls.get(sha);
    if (have) return setUrl(have);
    let alive = true;
    void loadPicture(api, sha).then((data) => alive && setUrl(data));
    return () => {
      alive = false;
    };
  }, [sha, api]);
  return sha ? url : undefined;
};
