import os from 'node:os';
import path from 'node:path';
import type { Session } from '../core/session.js';
import { webAccessOf } from '../daemon/web-access.js';
import type { Args, Method } from './api.js';

/** What each `web.*` method does (see web-api.ts). */

type WebMethod = Extract<Method, `web.${string}`>;
type WebHandlers = { readonly [M in WebMethod]: (s: Session, ...args: Args<M>) => unknown };

export const WEB_HANDLERS = {
  'web.link': (s, opts) => webAccessOf(s).link(opts?.listen, opts?.allowHosts, opts?.insecureHttp, opts?.via),
  'web.ways': (s) => webAccessOf(s).ways(),
  'web.sessions.list': (s) => webAccessOf(s).status(),
  'web.sessions.revoke': (s, idOrName) => webAccessOf(s).revoke(idOrName),
  'web.stop': (s) => webAccessOf(s).stop(),
  'web.tailscale': async (s, on) => {
    if (on) return webAccessOf(s).goTailscale();
    await webAccessOf(s).stopTailscale();
    return null;
  },
  'web.public': async (s, on) => {
    if (on) return webAccessOf(s).goPublic();
    webAccessOf(s).stopPublic();
    return null;
  },
  'web.download': async (s, target) => {
    const { files } = webAccessOf(s);
    if ('path' in target) return files.offer(path.resolve(target.path.replace(/^~(?=$|[\\/])/, os.homedir())));
    const name = target.at.path.split('/').pop() || 'download';
    const to = files.scratch(name);
    await s.download(target.at, { to });
    return files.offer(to, { name, temporary: true });
  },
} satisfies WebHandlers;
