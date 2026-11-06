import type { Sentinel, Trigger, WebhookState } from '../model.js';
import { startBeluga } from './beluga.js';
import { startGitHub } from './github.js';
import { startSentry } from './sentry.js';
import type { TriggerContext, TriggerDeps, TriggerEvent } from './types.js';
import { startUptime } from './uptime.js';
import { type HookOf, WebhookHub } from './webhook.js';

/**
 * The event triggers' coordinator: each sentinel that's on with an event trigger has its watcher
 * running (a poller, a listener, or its place on the webhook server), started when it's made or
 * turned on, restarted when its trigger or project changes, stopped when it's paused or deleted,
 * and all of them stopped with the daemon.
 */

export const EVENT_KINDS: ReadonlySet<Trigger['kind']> = new Set(['beluga', 'github', 'uptime', 'sentry', 'webhook']);
export const isEventTrigger = (t: Trigger): boolean => EVENT_KINDS.has(t.kind);

export interface TriggersHost {
  readonly deps: TriggerDeps;
  readonly cursor: (sentinelId: string) => unknown;
  readonly saveCursor: (sentinelId: string, cursor: unknown) => void;
  readonly fire: (sentinelId: string, event: TriggerEvent) => void;
  readonly trouble: (sentinelId: string, words: string | undefined) => void;
  readonly webhookState: (state: WebhookState) => void;
  /** A webhook sentinel's secret and how its posts are signed. */
  readonly hook: (sentinelId: string) => HookOf | undefined;
}

/** What makes a watcher different: a change here restarts it. */
const keyOf = (s: Sentinel): string => JSON.stringify({ t: s.trigger, p: s.projectId ?? null });

export class Triggers {
  private readonly running = new Map<string, { readonly key: string; readonly stop: () => void; readonly token: object }>();
  readonly webhooks: WebhookHub;
  private closed = false;

  constructor(private readonly host: TriggersHost) {
    this.webhooks = new WebhookHub({
      hook: (id) => host.hook(id),
      fire: (id, e) => host.fire(id, e),
      onState: (st) => host.webhookState(st),
      ...(host.deps.tunnel ? { tunnel: host.deps.tunnel } : {}),
      ...(host.deps.now ? { now: host.deps.now } : {}),
      ...(host.deps.log ? { log: host.deps.log } : {}),
    });
  }

  /** The sentinels now: what should watch does, what shouldn't stops. */
  sync(items: readonly Sentinel[]): void {
    if (this.closed) return;
    const want = new Map(items.filter((s) => !s.paused && isEventTrigger(s.trigger)).map((s) => [s.id, s]));
    for (const [id, r] of this.running) {
      const s = want.get(id);
      if (s && keyOf(s) === r.key) continue;
      r.stop();
      this.running.delete(id);
      this.host.trouble(id, undefined);
    }
    for (const [id, s] of want) {
      if (this.running.has(id)) continue;
      const token = {};
      this.running.set(id, { key: keyOf(s), token, stop: () => undefined });
      const stop = this.start(s, token);
      const r = this.running.get(id);
      if (r?.token === token) this.running.set(id, { ...r, stop });
      else stop();
    }
  }

  /** Which sentinels watch now (the tests). */
  watching = (): string[] => [...this.running.keys()];

  stopAll(): void {
    this.closed = true;
    for (const r of this.running.values()) r.stop();
    this.running.clear();
    this.webhooks.close();
  }

  private start(s: Sentinel, token: object): () => void {
    const id = s.id;
    // A watcher stopped (or replaced) while a look was out says nothing more.
    const live = (): boolean => this.running.get(id)?.token === token;
    const ctx: TriggerContext<never> = {
      sentinel: s,
      cursor: () => this.host.cursor(id) as never,
      save: (c) => void (live() && this.host.saveCursor(id, c)),
      fire: (e) => void (live() && this.host.fire(id, e)),
      trouble: (w) => void (live() && this.host.trouble(id, w)),
    };
    const deps = this.host.deps;
    const t = s.trigger;
    try {
      switch (t.kind) {
        case 'beluga':
          return startBeluga(t, ctx, deps);
        case 'github':
          return startGitHub(t, ctx, deps);
        case 'uptime':
          return startUptime(t, ctx, deps);
        case 'sentry':
          return startSentry(t, ctx, deps);
        case 'webhook':
          this.webhooks.add(id);
          return () => this.webhooks.remove(id);
        default:
          return () => undefined;
      }
    } catch (err) {
      this.host.trouble(id, err instanceof Error ? err.message : String(err));
      return () => undefined;
    }
  }
}
