import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCodeOf } from '../core/claude-code/launch.js';
import { belugaEnv } from '../core/beluga-env.js';
import { belugaHome } from '../core/home.js';
import { loadSettings } from '../core/settings.js';
import type { Session } from '../core/session.js';
import type { Store } from '../core/store.js';
import { installedVersion } from '../core/version.js';
import { dispatchCall } from '../daemon/dispatch.js';
import type { Identity } from '../net/crypto.js';
import { listScratch } from '../workspaces/scratch.js';
import { isSentPath } from '../shared/scratch-dir.js';
import { assistantOf } from '../core/assistant/registry.js';
import { ASSISTANT_CHANNEL, isAssistant } from '../shared/assistant.js';
import { DeviceBook } from './devices.js';
import { CompanionHost } from './host.js';
import { idleWhenWatched } from './push.js';
import { attachCompanion, detachCompanion } from './registry.js';
import type { ConvOutput } from './views.js';
import { needSentinel } from '../core/sentinel/registry.js';

/**
 * Start the phone companion for the daemon (the Mac app's Beluga): the device book in
 * ~/.beluga/devices.json and the CompanionHost (which runs a DHT node only while a phone is
 * paired or a pairing is open). The demo keeps its phones in a temporary folder.
 *
 * Outputs for the phone's views come from disk, so they're gathered here in the background (a
 * conversation's scratch folder, and what its sub-agents made, as the Mac's Outputs tab shows
 * them) for the conversations a phone has open plus the latest few, every few seconds while a
 * phone is linked; views read the cache, never the disk.
 */

const REFRESH_MS = 5_000;
/** Besides the ones on a phone's screen: the latest conversations, for Home's outputs strip. */
const RECENT = 8;

class OutputCache {
  private readonly cache = new Map<string, readonly ConvOutput[]>();
  private watched: readonly string[] = [];
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly session: Session,
    private readonly store: Store,
    private readonly changed: () => void,
  ) {}

  // Your Mac's chats share its folder, so its outputs (BLG-102).
  get = (channel: string): readonly ConvOutput[] => this.cache.get(isAssistant(channel) ? ASSISTANT_CHANNEL : channel) ?? [];

  watch(channels: readonly string[], linked: boolean): void {
    this.watched = channels;
    if (linked && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
      this.timer.unref();
      void this.refresh();
    } else if (!linked && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    } else if (linked) void this.refresh();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private channels(): string[] {
    const state = this.store.getState();
    const last = new Map<string, number>();
    for (const l of state.log) if (l.channel.startsWith('ws:')) last.set(l.channel, Math.max(last.get(l.channel) ?? 0, l.ts));
    const recent = [...last.entries()].sort((a, b) => b[1] - a[1]).slice(0, RECENT).map(([c]) => c);
    // Your Mac always: Home's "Ask your Mac" counts what it sent you.
    return [...new Set([ASSISTANT_CHANNEL, ...this.watched, ...recent])];
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = this.store.getState();
      let moved = false;
      for (const channel of this.channels()) {
        if (channel === ASSISTANT_CHANNEL) {
          // Its scratch folder: the screenshots and files it sent you (core/assistant).
          const mine = (await assistantOf(this.session)?.outputs().catch(() => [])) ?? [];
          const all = mine.slice(0, 100);
          if (JSON.stringify(this.cache.get(channel)) !== JSON.stringify(all)) moved = true;
          this.cache.set(channel, all);
          continue;
        }
        const wsId = channel.slice(3);
        const ws = state.projects.flatMap((p) => p.workspaces).find((w) => w.id === wsId);
        if (!ws?.path) continue;
        // What you sent Claude (sent/) is yours, not one of its outputs.
        const scratch = (await listScratch(ws.path).catch(() => [])).filter((f) => !isSentPath(f.path)).map((f) => ({ path: path.join(ws.path, f.path), size: f.size, ts: f.mtime, cwd: ws.path }));
        const agents = this.agentOutputs(wsId, ws.path);
        const all = [...agents, ...scratch].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).slice(0, 100);
        const before = this.cache.get(channel);
        if (JSON.stringify(before) !== JSON.stringify(all)) moved = true;
        this.cache.set(channel, all);
      }
      if (moved) this.changed();
    } finally {
      this.busy = false;
    }
  }

  /** What the sub-agents of this workspace's own Claude Code sessions made (claudeCode.outputs). */
  private agentOutputs(wsId: string, cwd: string): ConvOutput[] {
    let watcher: ReturnType<typeof claudeCodeOf>;
    try {
      watcher = claudeCodeOf(this.session);
    } catch {
      return [];
    }
    return this.store
      .getState()
      .claudeCode.sessions.filter((s) => s.workspaceId === wsId)
      .flatMap((s) =>
        s.agents.flatMap((a) =>
          watcher.outputs(s.id, a.id).outputs.map((o) => ({ path: o.path, size: o.size, ts: o.mtime, by: a.toolUseId ?? a.id, cwd })),
        ),
      );
  }
}

export interface CompanionLaunch {
  readonly session: Session;
  readonly store: Store;
  readonly identity: Identity;
  readonly demo: boolean;
  readonly log?: (line: string) => void;
  /** The daemon's terminals: a worktree's, shared with the phone. */
  readonly terminals?: import('../terminal/pty-host.js').TerminalManager;
}

/** The Mac's name as people know it ("Kayra’s MacBook Pro"): the one set in `beluga setup`, its Sharing name, else its host name. */
let named: string | undefined;
function macName(): string {
  if (named) return named;
  named = loadSettings().computerName;
  if (named) return named;
  try {
    if (process.platform === 'darwin') named = execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2_000 }).trim() || undefined;
  } catch {
    // no scutil: the host name will do
  }
  named ??= os.hostname().replace(/\.local$/, '').replace(/-/g, ' ') || (process.platform === 'darwin' ? 'Your Mac' : 'Your computer');
  return named;
}

/**
 * BELUGA_DHT_BOOTSTRAP="127.0.0.1:49737,…": the phones' network is a local testnet (tests that run
 * the daemon whole, such as `beluga pair` in a terminal); unset, the public one.
 */
export function dhtFromEnv(env: NodeJS.ProcessEnv = process.env): { dht?: { bootstrap: { host: string; port: number }[]; host: string } } {
  const raw = belugaEnv('DHT_BOOTSTRAP', env);
  if (!raw) return {};
  const bootstrap = raw.split(',').map((a) => /^\s*([\w.-]+):(\d+)\s*$/.exec(a)).filter((m): m is RegExpExecArray => Boolean(m)).map((m) => ({ host: m[1]!, port: Number(m[2]) }));
  return bootstrap.length ? { dht: { bootstrap, host: '127.0.0.1' } } : {};
}

export function launchCompanion(opts: CompanionLaunch): () => Promise<void> {
  const dir = opts.demo ? mkdtempSync(path.join(os.tmpdir(), 'beluga-demo-companion-')) : belugaHome();
  const devices = new DeviceBook(path.join(dir, 'devices.json'));
  let host: CompanionHost | undefined;
  const outputs = new OutputCache(opts.session, opts.store, () => host?.refreshViews());
  host = new CompanionHost({
    identity: opts.identity,
    store: opts.store,
    devices,
    call: (clientId, method, args) => dispatchCall(opts.session, clientId, method, args),
    macName,
    ...dhtFromEnv(),
    version: installedVersion(),
    thumbsDir: path.join(dir, 'companion', 'thumbs'),
    macrosFile: path.join(dir, 'phone-macros.json'),
    outputs: outputs.get,
    // A kept table's documents and storage objects, streamed to the phone from memory (BLG-386).
    documents: (d) => {
      const sn = needSentinel(opts.session);
      if (d.run !== undefined) return Promise.resolve(sn.runFileBytes(d.run, d.name));
      if (d.history !== undefined) {
        const out = sn.metricExport(d.sentinelId, d.history, 'csv');
        return Promise.resolve({ name: out.name, mime: out.mime, bytes: new TextEncoder().encode(out.text) });
      }
      return sn.documentBytes(d.sentinelId, d.metric, d.column, d.value);
    },
    watching: (channels, linked) => outputs.watch(channels, linked),
    idleMs: idleWhenWatched(() => opts.session.attention.screens),
    ...(opts.terminals ? { terminals: opts.terminals } : {}),
    // The relay through Cloudflare, unless Remote access is set to direct only (or the network only),
    // or it's the demo (nothing leaves the computer).
    relay: opts.demo || ['p2p', 'none'].includes(opts.store.getState().prefs.tunnel) ? 'off' : 'cloudflared',
    ...(opts.log ? { log: opts.log } : {}),
  });
  attachCompanion(opts.session, host);
  void host.start().catch((err: unknown) => opts.log?.(`companion: could not start: ${String(err)}`));
  // A phone on this Mac's USB: set up by itself, or what to switch on said in Settings › Phone (BLG-190).
  if (!opts.demo) host.watchCable();
  return async () => {
    outputs.stop();
    detachCompanion(opts.session);
    await host?.stop();
    host = undefined;
  };
}
