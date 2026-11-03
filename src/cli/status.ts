import type { DomainState } from '../core/store.js';
import type { DaemonInfo } from '../ipc/protocol.js';
import { NOT_RUNNING, withDaemon } from './attach.js';
import { type Exit, type Io, ago } from './io.js';
import { tilde } from './paths.js';
import type { WebStatus } from '../daemon/web-access.js';

/** What `beluga status` reports (and prints as JSON with --json). */
export interface StatusReport {
  readonly running: boolean;
  readonly version?: string;
  readonly pid?: number;
  readonly port?: number;
  readonly startedAt?: number;
  readonly keptAlive?: boolean;
  readonly room?: string;
  readonly projects: ReadonlyArray<{ readonly name: string; readonly root: string; readonly problem?: string }>;
  readonly phones: ReadonlyArray<{ readonly name: string; readonly platform: string; readonly linked: boolean; readonly lastSeen?: number }>;
  /** The relay phones reach this computer through when a direct link can't be made. */
  readonly relay?: 'ready' | 'starting' | 'off';
  /** Remote access is set to direct only (or this network only): no relay at all. */
  readonly relayDisabled?: boolean;
  /** What keeps it running from boot (`beluga service install`), if anything. */
  readonly service?: 'systemd' | 'launchd';
  /** Opening Beluga in a browser: its web port, its address and how many browsers are let in. */
  readonly web: { readonly on: boolean; readonly url?: string; readonly sessions: number; readonly public?: WebStatus['public']; readonly tailscale?: WebStatus['tailscale'] };
}

export function report(info: DaemonInfo, domain: Pick<DomainState, 'projects' | 'companion'> & { readonly prefs?: Pick<DomainState['prefs'], 'tunnel'> }, web?: WebStatus): StatusReport {
  return {
    running: true,
    version: info.version,
    pid: info.pid,
    port: info.port,
    startedAt: info.startedAt,
    keptAlive: info.keepAlive ?? false,
    room: info.room,
    projects: domain.projects.filter((p) => p.root).map((p) => ({ name: p.name, root: p.root, ...(p.error ? { problem: p.error } : {}) })),
    phones: domain.companion.devices.map((d) => ({ name: d.name, platform: d.platform, linked: d.linked, ...(d.lastSeen ? { lastSeen: d.lastSeen } : {}) })),
    ...(domain.companion.relay ? { relay: domain.companion.relay } : {}),
    ...(domain.prefs?.tunnel === 'p2p' || domain.prefs?.tunnel === 'none' ? { relayDisabled: true } : {}),
    web: { on: web?.on ?? false, ...(web?.url ? { url: web.url } : {}), sessions: web?.sessions.length ?? 0, ...(web?.public ? { public: web.public } : {}), ...(web?.tailscale ? { tailscale: web.tailscale } : {}) },
  };
}

/**
 * The relay in words: it runs only while a phone is paired (or a pairing is open), so with none
 * it isn't "off", it hasn't started yet.
 */
export function relayWords(r: Pick<StatusReport, 'relay' | 'relayDisabled' | 'phones'>): string {
  if (r.relayDisabled) return 'off: Remote access is set to direct connections only';
  if (r.relay === 'ready') return 'ready, for when a phone can’t connect directly';
  if (r.relay === 'starting') return 'starting';
  if (!r.phones.length) return 'starts when a phone is paired';
  return 'not running: phones connect only directly for now (`beluga logs` says why)';
}

/** Browser access in words: the web port's address and the browsers let in, or how to open it. */
export function webWords(w: StatusReport['web']): string {
  if (!w.on) return 'off. `beluga web` opens it and gives a link for a browser.';
  const n = w.sessions;
  const pub = !w.public ? '' : w.public.url ? `, and public at ${w.public.url}` : w.public.state === 'reopening' ? ', and its public link is reopening' : ', and its public link is opening';
  const tailnet = w.tailscale ? `, on your tailnet at ${w.tailscale.url}` : '';
  return `on${w.url ? `, at ${w.url}` : ''}${tailnet}${pub} (${n ? `${n} browser${n === 1 ? '' : 's'} let in` : 'no browser let in yet'}). \`beluga web\` gives a link${w.public || w.tailscale ? ', `beluga web --off` closes it' : ''}.`;
}

/** The report in plain words, with what to do next where something's missing. */
export function describe(r: StatusReport, now = Date.now()): string {
  if (!r.running) return NOT_RUNNING;
  const lines = [`Beluga ${r.version} is running (pid ${r.pid}, up ${ago(now - (r.startedAt ?? now))}), on 127.0.0.1:${r.port} for this computer only.`];
  if (!r.keptAlive) lines.push('  It stops when the last window closes; `beluga stop` then `beluga up` keeps it running.');
  lines.push('');
  if (!r.projects.length) lines.push('Projects: none yet. Add one with `beluga project add <folder or git URL>`.');
  else {
    lines.push(`Projects (${r.projects.length}):`);
    const width = Math.max(...r.projects.map((p) => p.name.length));
    for (const p of r.projects) lines.push(`  ${p.name.padEnd(width)}  ${tilde(p.root)}${p.problem ? `  (can't open: ${p.problem})` : ''}`);
  }
  if (!r.phones.length) lines.push('Phones: none paired. Pair one with `beluga pair`.');
  else {
    lines.push(`Phones (${r.phones.length}):`);
    for (const p of r.phones) lines.push(`  ${p.name} (${p.platform}), ${p.linked ? 'linked now' : p.lastSeen ? `last seen ${ago(now - p.lastSeen)} ago` : 'not seen yet'}`);
  }
  lines.push(`Phone relay: ${relayWords(r)}`);
  lines.push(r.service ? `Keeps running: yes (${r.service === 'systemd' ? 'a systemd user service' : 'a launchd agent'})` : 'Keeps running: only until this computer restarts. `beluga service install` starts it at boot.');
  lines.push(`Browser access: ${webWords(r.web)}`);
  return `${lines.join('\n')}\n`;
}

/** `beluga status`: running or not, version, projects, phones, browser access. */
export async function status(flags: { json?: boolean }, io: Io): Promise<Exit> {
  const found = (await withDaemon(async (client, info) => report(info, client.store.getDomain(), await client.call('web.sessions.list').catch(() => undefined)))) ?? { running: false, projects: [], phones: [], web: { on: false, sessions: 0 } };
  const { serviceEnv, serviceInstalled } = await import('./service.js');
  const env = serviceEnv();
  const r: StatusReport = serviceInstalled(env) ? { ...found, service: env.platform === 'linux' ? 'systemd' : 'launchd' } : found;
  io.out(flags.json ? `${JSON.stringify(r, null, 2)}\n` : describe(r));
  return r.running ? 0 : 1;
}
