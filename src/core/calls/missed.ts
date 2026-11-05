import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MissedCallView } from '../../shared/calls.js';

/**
 * Calls you missed: one rang for you and stopped before you answered or said not now. Each sits
 * in its conversation where it rang ("Ann tried calling you at 14:05"), kept on disk
 * (`~/.beluga/missed-calls.json`, only you can read it) so it's still there after a restart.
 */

const Missed = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  conversation: z.string().max(80),
  by: z.string().max(200),
  name: z.string().max(80),
  at: z.number().int().min(0),
});
const File = z.array(Missed);

/** Missed calls kept per conversation, and for how long. */
const PER_CONVERSATION = 20;
const KEEP_MS = 30 * 24 * 60 * 60_000;

export interface MissedCallsHost {
  /** The file they live in; null: memory only (the demo, tests). */
  readonly file: string | null;
  readonly publish: (missed: Readonly<Record<string, readonly MissedCallView[]>>) => void;
  readonly now?: () => number;
}

export class MissedCalls {
  private list: MissedCallView[] = [];

  constructor(private readonly host: MissedCallsHost) {
    if (!host.file) return;
    try {
      const parsed = File.safeParse(JSON.parse(readFileSync(host.file, 'utf8')));
      if (parsed.success) this.list = this.trim(parsed.data);
    } catch {
      // None yet.
    }
  }

  add(call: MissedCallView): void {
    const parsed = Missed.safeParse(call);
    if (!parsed.success || this.list.some((m) => m.id === call.id && m.conversation === call.conversation)) return;
    this.list = this.trim([...this.list, parsed.data]);
    this.save();
    this.host.publish(this.views());
  }

  views(): Record<string, MissedCallView[]> {
    const by: Record<string, MissedCallView[]> = {};
    for (const m of this.list) (by[m.conversation] ??= []).push(m);
    return by;
  }

  /** Oldest first, none too old, the latest few of each conversation. */
  private trim(list: readonly MissedCallView[]): MissedCallView[] {
    const since = (this.host.now?.() ?? Date.now()) - KEEP_MS;
    const fresh = [...list].filter((m) => m.at >= since).sort((a, b) => a.at - b.at);
    const count = new Map<string, number>();
    const kept = fresh.reverse().filter((m) => {
      const n = (count.get(m.conversation) ?? 0) + 1;
      count.set(m.conversation, n);
      return n <= PER_CONVERSATION;
    });
    return kept.reverse();
  }

  private save(): void {
    const file = this.host.file;
    if (!file) return;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list), { mode: 0o600 });
    renameSync(tmp, file);
  }
}
