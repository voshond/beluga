import WebSocket from 'ws';
import { SocketClient, type SocketLike } from './ipc/socket-client.js';
import { runningDaemon } from './daemon/files.js';
import { type WebArgs, splitWebArgs, sshWords } from './daemon/web.js';
import { type WebSessionInfo, WebSessions } from './daemon/web-sessions.js';
import { forgetWebConfig, readWebConfig } from './daemon/web-access.js';
import { publicWords } from './daemon/reach/public.js';
import { TailscaleReach, tailscaleWords } from './daemon/reach/tailscale.js';
import { qrLines } from './cli/qr.js';

/**
 * `beluga web …`: `web` gives a join link from the Beluga that's running (opening its web port),
 * or, when none is, runs one here with it; `web sessions` lists the browsers let in, `web revoke
 * <id or name>` cuts one off, `web stop` closes the port.
 */

export const WEB_USAGE = `beluga web [--listen host:port] [--allow-host name] [--insecure-http]   a link that lets a browser in (opens the web port, 127.0.0.1:7777)
beluga web --public                                     a https link that works anywhere (a Cloudflare tunnel); anyone with a join link gets in
beluga web --tailscale                                  https on your tailnet (Tailscale Serve); your own login gets in
beluga web --off                                        browser access off: the web port, the public link, Tailscale Serve
beluga web link                                         another link from the Beluga that runs
beluga web sessions                                     the browsers let in
beluga web revoke <id or name>                          sign a browser out now
beluga web stop                                         close the web port`;

type Out = (text: string) => void;

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return 'just now';
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

export function formatSessions(sessions: readonly WebSessionInfo[], now = Date.now()): string {
  if (!sessions.length) return 'No browsers are let in. Run `beluga web` for a link.\n';
  return `${sessions.map((s) => `${s.id}  ${s.name.padEnd(24)}  joined ${new Date(s.createdAt).toLocaleDateString()}, last seen ${ago(now - s.lastSeenAt)}`).join('\n')}\n`;
}

async function attach(): Promise<SocketClient | undefined> {
  const info = runningDaemon();
  if (!info) return undefined;
  return SocketClient.connect({ url: `ws://127.0.0.1:${info.port}`, token: info.token, kind: 'cli', version: info.version, connect: (url) => new WebSocket(url) as unknown as SocketLike });
}

/**
 * Run a `web` command. Resolves to the web port's settings when Beluga should run here, in the
 * foreground, with it open (no Beluga was running); undefined once the command is done.
 */
export async function webCommand(argv: readonly string[], out: Out = (t) => void process.stdout.write(t)): Promise<{ web: WebArgs; rest: string[] } | undefined> {
  const [sub, ...rest] = argv;
  if (sub === 'sessions' || sub === 'revoke' || sub === 'stop') {
    const client = await attach();
    try {
      if (sub === 'sessions') {
        out(formatSessions(client ? (await client.call('web.sessions.list')).sessions : new WebSessions().list()));
      } else if (sub === 'revoke') {
        const name = rest.join(' ').trim();
        if (!name) throw new Error('Which browser? `beluga web sessions` lists them.');
        const gone = client ? await client.call('web.sessions.revoke', name) : new WebSessions().revoke(name);
        out(`${gone.name} is signed out${client ? ' and cut off' : ''}.\n`);
      } else {
        if (!client) return void out('Beluga isn’t running: its web port is closed.\n');
        await client.call('web.stop');
        out('The web port is closed. `beluga web` opens it again.\n');
      }
    } finally {
      client?.close();
    }
    return undefined;
  }
  if (argv.includes('--off')) {
    if (argv.length > 1) throw new Error('`beluga web --off` takes nothing else.');
    const client = await attach();
    if (!client) {
      // Serve outlives Beluga (it's tailscaled's): stop it here too.
      if (readWebConfig()?.tailscale) await new TailscaleReach().stop();
      forgetWebConfig();
      return void out('Beluga isn’t running. Browser access stays off when it starts.\n');
    }
    try {
      await client.call('web.stop');
    } finally {
      client.close();
    }
    return void out('Browser access is off: the web port, any public link and Tailscale Serve are closed. `beluga web` opens it again.\n');
  }
  const link = sub === 'link';
  const { web, rest: daemonArgs } = splitWebArgs(link ? rest : argv);
  const client = await attach();
  // `web link` only asks: run over ssh (`beluga connect`), it must never keep a Beluga in that session.
  if (!client && link) throw new Error('Beluga isn’t running here. `beluga up` starts it.');
  if (!client) return { web, rest: daemonArgs };
  try {
    const listen = argv.some((a) => a.startsWith('--listen')) ? `${web.host.includes(':') ? `[${web.host}]` : web.host}:${web.port}` : undefined;
    const opts = { ...(listen ? { listen } : {}), ...(web.allowedHosts.length ? { allowHosts: [...web.allowedHosts] } : {}), ...(web.insecureHttp ? { insecureHttp: true } : {}) };
    if ((web.public || web.tailscale) && Object.keys(opts).length) await client.call('web.link', opts);
    if (web.tailscale) {
      const t = await client.call('web.tailscale', true);
      if (!t) throw new Error('Tailscale gave no address.');
      out(tailscaleWords(t, process.stdout.isTTY ? qrLines(t.url) : []));
      if (!web.public) return undefined;
    }
    if (web.public) {
      out('Opening a public link through Cloudflare…\n');
      const pub = await client.call('web.public', true);
      if (!pub) throw new Error('No public link came back.');
      return void out(publicWords(pub));
    }
    const { url, expiresAt } = await client.call('web.link', Object.keys(opts).length ? opts : undefined);
    out(`Open this link in your browser to let it in (once, until ${new Date(expiresAt).toLocaleTimeString()}):\n\n  ${url}\n\n${link ? '' : sshWords(new URL(url).origin)}`);
  } finally {
    client.close();
  }
  return undefined;
}
