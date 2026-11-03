import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type JoinLimiter, type WebSessions } from './web-sessions.js';
import { type WebRoute, html, json, sameOrigin } from './web.js';

/**
 * The web port's doors for a browser that isn't let in yet: the join page (it trades the link's
 * secret for a session cookie, then clears the secret from the address bar) and the Ask for a
 * link page everything else shows until then.
 */

export const COOKIE = 'beluga_session';
/** On https the cookie gets the __Host- prefix: Secure, this host only, path /. */
export const SECURE_COOKIE = `__Host-${COOKIE}`;
/** Browsers keep a cookie 400 days at most; the server forgets an idle one after 90 (web-sessions.ts). */
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const MAX_JOIN_BODY = 1024;

/** The session cookie's value in a request, if it has one: on https only the __Host- one (no other port or path could have set it). */
export function sessionCookie(req: IncomingMessage, https = false): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const values = new Map<string, string>();
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) values.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return https ? values.get(SECURE_COOKIE) : (values.get(COOKIE) ?? values.get(SECURE_COOKIE));
}

/** Whether the browser reached this over https (a TLS proxy in front says so, or the page's own Origin does). */
export const viaHttps = (req: IncomingMessage): boolean => req.headers['x-forwarded-proto'] === 'https' || (req.headers.origin ?? '').startsWith('https:');

/** The Set-Cookie for a new session: never readable by scripts, never sent from another site. */
export function setCookie(value: string, https: boolean): string {
  return `${https ? SECURE_COOKIE : COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}${https ? '; Secure' : ''}`;
}

const PAGE_STYLE = `body{font:15px/1.5 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;background:#f6f4fb;color:#3b3550;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:20px;margin:0 0 .5rem}p{margin:.5rem 0;color:#5d5672}
code{background:#ebe6f7;border-radius:6px;padding:.1rem .4rem;font-size:14px}.icon{width:44px;height:44px;border-radius:12px;background:#e3dcf7;display:inline-grid;place-items:center;margin-bottom:1rem}`;
const LOCK_ICON = `<span class="icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#6b5fa8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>`;

/** Shown to a browser without a session: how to get a link. Nothing of Beluga's own. */
export const ASK_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beluga</title><style>${PAGE_STYLE}</style>
<main>${LOCK_ICON}<h1>Ask for a link to open Beluga</h1><p>This browser isn't let in yet. On the computer Beluga runs on, run <code>beluga web</code> (or open Settings › Advanced › Web access) and open the link it gives you here.</p><p>A link works once, for 10 minutes.</p></main></html>`;

const JOIN_SCRIPT = `(function(){var s=location.hash.slice(1);history.replaceState(null,'','/join');var t=document.getElementById('t'),p=document.getElementById('p');
function fail(m){t.textContent='This link doesn\\u2019t work';p.textContent=m}
if(!s){fail('It has no secret in it. Ask for a new link: run beluga web on the computer Beluga runs on.');return}
fetch('/join',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({secret:s})})
.then(function(r){return r.json().then(function(b){if(r.ok)location.replace('/');else fail(b.error||'Ask for a new link.')})})
.catch(function(){fail('Beluga didn\\u2019t answer. Check it is running, then ask for a new link.')})})();`;
const JOIN_SCRIPT_HASH = createHash('sha256').update(JOIN_SCRIPT).digest('base64');
const JOIN_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Beluga</title><style>${PAGE_STYLE}</style>
<main>${LOCK_ICON}<h1 id="t">Letting this browser in…</h1><p id="p"></p></main><script>${JOIN_SCRIPT}</script></html>`;
/** Only that script, only to this origin, framed by nobody. */
const PAGE_CSP = `default-src 'none'; script-src 'sha256-${JOIN_SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

/** Answer a browser that isn't let in: the Ask page for a page load, a plain 401 for the rest. */
export function locked(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (url.pathname === '/__beluga/endpoint') return json(res, 401, { error: 'This browser is signed out of Beluga', signedOut: true });
  const page = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || (req.headers.accept ?? '').includes('text/html'));
  if (page) return html(res, 401, ASK_PAGE, { 'content-security-policy': PAGE_CSP });
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('Not signed in');
}

function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(undefined);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(undefined));
  });
}

/** Which limiter counts a request's wrong tries, and under whose name (a public tunnel's visitors get their own, stricter one). */
export type LimitFor = (req: IncomingMessage) => { readonly limiter: JoinLimiter; readonly who: string };

/** GET /join: the page; POST /join: the exchange (same origin only, rate-limited, once per link). */
export function joinRoute(sessions: WebSessions, limit: JoinLimiter | LimitFor, log?: (line: string) => void): WebRoute {
  const limitFor: LimitFor = typeof limit === 'function' ? limit : (req) => ({ limiter: limit, who: req.socket.remoteAddress ?? '?' });
  return async (req, res, url) => {
    if (url.pathname !== '/join') return false;
    if (req.method === 'GET') {
      html(res, 200, JOIN_PAGE, { 'content-security-policy': PAGE_CSP });
      return true;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'Method not allowed' });
      return true;
    }
    const origin = req.headers.origin;
    // A form or fetch from any other site (CSRF, a login-CSRF into your own session) stops here.
    if (!sameOrigin(origin, req.headers.host)) {
      json(res, 403, { error: 'Open the link in this browser’s address bar' });
      return true;
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      json(res, 415, { error: 'Expected JSON' });
      return true;
    }
    const { limiter, who } = limitFor(req);
    const body = await readBody(req, MAX_JOIN_BODY);
    let secret: unknown;
    try {
      secret = body ? (JSON.parse(body) as { secret?: unknown }).secret : undefined;
    } catch {
      secret = undefined;
    }
    const wellFormed = typeof secret === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(secret) ? secret : undefined;
    // A good link always works (junk can't lock its owner out); only wrong ones count, and too many are refused unread.
    const joined = wellFormed ? sessions.redeem(wellFormed, req.headers['user-agent']) : undefined;
    if (!joined && !limiter.allowed(who)) {
      json(res, 429, { error: 'Too many tries. Wait a few minutes, then ask for a new link.' }, { 'retry-after': '600' });
      return true;
    }
    if (!joined) {
      limiter.failed(who);
      json(res, 401, { error: 'This link was already used or has expired. Ask for a new one: run beluga web on the computer Beluga runs on.' });
      return true;
    }
    log?.(`web: ${joined.session.name} joined (${joined.session.id})`);
    json(res, 200, { ok: true, name: joined.session.name }, { 'set-cookie': setCookie(joined.cookie, new URL(origin!).protocol === 'https:') });
    return true;
  };
}
