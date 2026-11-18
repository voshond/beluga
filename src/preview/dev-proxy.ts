import { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions, type ServerResponse, request } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * A dev server on this computer (`http://localhost:5173`), carried to a page at the public preview
 * origin (public.ts) so a Beluga page on another computer can frame it: requests and websockets
 * (hot reload) go to the dev server as if the browser were here, and its answers come back
 * framable by Beluga's pages only.
 */

export interface DevTarget {
  readonly hostname: string;
  readonly port: number;
}

export const devTargetOf = (url: string): DevTarget => {
  const u = new URL(url);
  return { hostname: u.hostname, port: Number(u.port || 80) };
};

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'host', 'origin', 'referer', 'cookie']);

export const DEV_COOKIE = 'beluga_dev';

const withoutOurCookie = (cookie: string | undefined): string | undefined => {
  const kept = (cookie ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${DEV_COOKIE}=`) && !c.startsWith('beluga_preview='));
  return kept.length ? kept.join('; ') : undefined;
};

export function upstreamHeaders(headers: IncomingHttpHeaders, target: DevTarget, upgrade: boolean): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
  const here = `${target.hostname}:${target.port}`;
  out.host = here;
  if (headers.origin) out.origin = `http://${here}`;
  const cookie = withoutOurCookie(headers.cookie);
  if (cookie) out.cookie = cookie;
  if (upgrade) {
    out.connection = 'Upgrade';
    out.upgrade = headers.upgrade ?? 'websocket';
  }
  return out;
}

const FRAME_ANCESTORS = /frame-ancestors[^;]*/i;

export function framableHeaders(headers: IncomingHttpHeaders, target: DevTarget, ancestors: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || k === 'x-frame-options' || k === 'connection' || k === 'keep-alive' || k === 'transfer-encoding') continue;
    out[k] = v;
  }
  const csp = headers['content-security-policy'];
  if (typeof csp === 'string') out['content-security-policy'] = FRAME_ANCESTORS.test(csp) ? csp.replace(FRAME_ANCESTORS, `frame-ancestors ${ancestors}`) : csp;
  const location = headers.location;
  if (location) {
    try {
      const to = new URL(location, `http://${target.hostname}:${target.port}`);
      const local = ['localhost', '127.0.0.1', '[::1]', target.hostname].includes(to.hostname) && Number(to.port || 80) === target.port;
      if (local) out.location = `${to.pathname}${to.search}${to.hash}`;
    } catch {
      /* not an address: as it was */
    }
  }
  return out;
}

const optionsFor = (target: DevTarget, req: IncomingMessage, upgrade: boolean): RequestOptions => {
  const options: RequestOptions & { readonly autoSelectFamily: boolean } = { host: target.hostname, port: target.port, method: req.method, path: req.url ?? '/', headers: upstreamHeaders(req.headers, target, upgrade), autoSelectFamily: true };
  return options;
};

export function forwardDev(target: DevTarget, ancestors: string, req: IncomingMessage, res: ServerResponse): void {
  const upstream = request(optionsFor(target, req, false), (answer) => {
    res.writeHead(answer.statusCode ?? 502, framableHeaders(answer.headers, target, ancestors));
    answer.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`Nothing answers at ${target.hostname}:${target.port} on this computer`);
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

const rawHead = (status: number, message: string, headers: IncomingHttpHeaders): string => {
  const lines = [`HTTP/1.1 ${status} ${message}`];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
};

export function forwardDevUpgrade(target: DevTarget, req: IncomingMessage, socket: Duplex, head: Buffer, onClose: () => void): void {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    onClose();
  };
  socket.on('close', close);
  socket.on('error', () => socket.destroy());
  const upstream = request(optionsFor(target, req, true));
  upstream.on('upgrade', (answer, theirs, theirHead) => {
    socket.write(rawHead(101, 'Switching Protocols', answer.headers));
    if (theirHead.length) socket.write(theirHead);
    if (head.length) theirs.write(head);
    theirs.on('error', () => socket.destroy());
    theirs.on('close', () => socket.destroy());
    socket.on('close', () => theirs.destroy());
    theirs.pipe(socket).pipe(theirs);
  });
  upstream.on('response', (answer) => {
    socket.end(rawHead(answer.statusCode ?? 502, answer.statusMessage ?? 'Bad Gateway', { ...answer.headers, connection: 'close' }));
    answer.resume();
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
}
