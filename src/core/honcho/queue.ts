import { HonchoError } from './client.js';
import type { Outgoing } from './filter.js';

export type Deliver = (batch: readonly Outgoing[]) => Promise<void>;

export type QueueDeps = {
  readonly deliver: Deliver;
  readonly onSent: (count: number) => void;
  readonly onError: (message: string) => void;
  readonly onChange?: () => void;
  readonly maxItems?: number;
  readonly maxChars?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
};

const MAX_ITEMS = 1000;
const MAX_CHARS = 2_000_000;
const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 5 * 60_000;
const MAX_BATCH = 100;
const SEEN_MAX = 5000;

export class HonchoQueue {
  private items: Outgoing[] = [];
  private readonly seen = new Set<string>();
  private attempts = 0;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly deps: QueueDeps) {}

  get size(): number {
    return this.items.length;
  }

  get waiting(): readonly Outgoing[] {
    return this.items;
  }

  push = (item: Outgoing): void => {
    if (this.stopped || this.seen.has(item.id)) return;
    this.remember(item.id);
    this.items.push(item);
    this.trim();
    this.deps.onChange?.();
    if (!this.timer) this.schedule(0);
  };

  restore = (items: readonly Outgoing[]): void => {
    if (this.stopped) return;
    const fresh = items.filter((i) => !this.seen.has(i.id));
    for (const i of fresh) this.remember(i.id);
    this.items = [...fresh, ...this.items];
    this.trim();
    if (this.items.length && !this.timer) this.schedule(0);
  };

  clear = (): void => {
    this.items = [];
    this.attempts = 0;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.deps.onChange?.();
  };

  stop = (): void => {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  };

  flush = async (): Promise<void> => {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.items.length && !this.stopped) {
        const batch = this.nextBatch();
        try {
          await this.deps.deliver(batch);
        } catch (err) {
          if (this.handleFailure(batch, err)) return;
          continue;
        }
        this.attempts = 0;
        this.drop(batch);
        this.deps.onSent(batch.length);
      }
    } finally {
      this.running = false;
    }
  };

  private handleFailure(batch: readonly Outgoing[], err: unknown): boolean {
    const message = err instanceof Error ? err.message : 'Honcho failed';
    this.deps.onError(message);
    const retry = !(err instanceof HonchoError) || err.retry;
    this.attempts += 1;
    if (!retry || this.attempts >= (this.deps.maxAttempts ?? MAX_ATTEMPTS)) {
      this.drop(batch);
      this.attempts = 0;
      return false;
    }
    const delay = Math.min((this.deps.baseDelayMs ?? BASE_DELAY_MS) * 2 ** (this.attempts - 1), this.deps.maxDelayMs ?? MAX_DELAY_MS);
    this.schedule(delay);
    return true;
  }

  private nextBatch(): Outgoing[] {
    const session = this.items[0]!.conversation.session;
    return this.items.filter((i) => i.conversation.session === session).slice(0, MAX_BATCH);
  }

  private drop(batch: readonly Outgoing[]): void {
    const gone = new Set(batch);
    this.items = this.items.filter((i) => !gone.has(i));
    this.deps.onChange?.();
  }

  private trim(): void {
    const max = this.deps.maxItems ?? MAX_ITEMS;
    if (this.items.length > max) this.items.splice(0, this.items.length - max);
    const maxChars = this.deps.maxChars ?? MAX_CHARS;
    let chars = this.items.reduce((n, i) => n + i.content.length, 0);
    while (chars > maxChars && this.items.length > 1) chars -= this.items.shift()!.content.length;
  }

  private remember(id: string): void {
    this.seen.add(id);
    if (this.seen.size <= SEEN_MAX) return;
    const oldest = this.seen.values().next().value;
    if (oldest !== undefined) this.seen.delete(oldest);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ms);
    this.timer.unref?.();
  }
}
