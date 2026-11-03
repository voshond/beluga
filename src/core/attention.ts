import { type Attention, NO_ATTENTION, type Store } from './store.js';

const union = (lists: ReadonlyArray<readonly string[]>): string[] => [...new Set(lists.flat())].sort();
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * What each attached screen looks at, combined: a conversation is shown when any screen shows
 * it, and visible when a screen in front shows it. Unread counts and notifications follow this.
 * A screen is in front while its window has focus; a terminal that can't report focus counts
 * as in front only while it's being used (see ui/tty/front.ts), so a forgotten one doesn't
 * silence notifications everywhere.
 */
export class AttentionRegistry {
  private readonly byClient = new Map<string, Attention>();

  constructor(private readonly store: Store) {}

  set(clientId: string, attention: Attention): void {
    this.byClient.set(clientId, attention);
    this.publish();
  }

  remove(clientId: string): void {
    if (this.byClient.delete(clientId)) this.publish();
  }

  /** How many screens say what they look at: none on a server with no window open. */
  get screens(): number {
    return this.byClient.size;
  }

  /** Whether some screen in front shows this conversation. */
  visible(channel: string): boolean {
    return this.store.getState().attention.visible.includes(channel);
  }

  private publish(): void {
    const all = [...this.byClient.values()];
    const next: Attention = all.length
      ? { shown: union(all.map((a) => a.shown)), visible: union(all.map((a) => a.visible)), files: all.some((a) => a.files), front: all.some((a) => a.front) }
      : NO_ATTENTION;
    const now = this.store.getState().attention;
    if (same(now.shown, next.shown) && same(now.visible, next.visible) && now.files === next.files && now.front === next.front) return;
    this.store.dispatch({ type: 'attention', attention: next });
  }
}
