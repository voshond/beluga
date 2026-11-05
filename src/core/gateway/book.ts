import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readJson, safeName, writeJson } from '../../net/mesh/files.js';
import { KEEP_TASKS, type PeerCard, type TaskView, isFinal } from './model.js';
import { type Frame, MAX_FILE_TOTAL, type ResultFile, TaskResult } from './protocol.js';

/**
 * The gateway's files under ~/.beluga/tasks/ (readable only by you): tasks.json (your last
 * KEEP_TASKS tasks, sent and received, and the cards friends told you), outbox.json (what waits
 * for someone to come online, 7 days at most), files/<task>/ (what results brought back) and
 * work/<task>/ (the scratch folder a friend's task runs in when it names no project).
 * Without a folder (tests, the demo's simulated friends) everything stays in memory.
 */

export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OUTBOX = 500;

export interface Outgoing {
  readonly to: string;
  readonly frame: Extract<Frame, { f: string }>;
  readonly expiresAt: number;
  /** When it was last handed to a link or the room (resent if no ack comes). */
  readonly sentAt?: number;
  /** When it went to their mailbox (BLG-272: they and you weren't online together). */
  readonly mailedAt?: number;
}

const TasksFile = z.object({ version: z.literal(1), tasks: z.array(z.unknown()), cards: z.record(z.string(), z.unknown()).default({}), pending: z.record(z.string(), z.unknown()).default({}) });

/** A task as saved: the same as its view (loose check: it's our own file). */
const SavedTask = z
  .object({ id: z.string(), direction: z.enum(['sent', 'received']), peerId: z.string(), peerName: z.string(), ask: z.string(), state: z.string(), createdAt: z.number(), updatedAt: z.number() })
  .passthrough();

export class TaskBook {
  private tasks: readonly TaskView[] = [];
  private cards: Readonly<Record<string, PeerCard>> = {};
  private outbox: readonly Outgoing[] = [];
  /** Results whose big files are still being fetched (kept, so a restart carries on). */
  private pendingResults: Readonly<Record<string, TaskResult>> = {};

  constructor(private readonly dir: string | null) {
    if (!dir) return;
    const parsed = TasksFile.safeParse(readJson(path.join(dir, 'tasks.json')));
    if (parsed.success) {
      this.tasks = parsed.data.tasks.flatMap((raw) => (SavedTask.safeParse(raw).success ? [raw as TaskView] : []));
      this.cards = parsed.data.cards as Record<string, PeerCard>;
      this.pendingResults = Object.fromEntries(
        Object.entries(parsed.data.pending).flatMap(([id, raw]) => {
          const r = TaskResult.safeParse(raw);
          return r.success ? [[id, r.data]] : [];
        }),
      );
    }
    const out = readJson(path.join(dir, 'outbox.json'));
    this.outbox = (Array.isArray(out) ? out : []).filter((o): o is Outgoing => typeof o === 'object' && o !== null && typeof (o as Outgoing).to === 'string' && typeof (o as Outgoing).frame?.f === 'string');
  }

  all = (): readonly TaskView[] => this.tasks;
  get = (id: string): TaskView | undefined => this.tasks.find((t) => t.id === id);
  allCards = (): Readonly<Record<string, PeerCard>> => this.cards;

  put(task: TaskView): TaskView {
    const others = this.tasks.filter((t) => t.id !== task.id);
    let next = [...others, task];
    // Over the limit: the oldest finished ones go first.
    while (next.length > KEEP_TASKS) {
      const drop = next.findIndex((t) => isFinal(t.state));
      next = next.filter((_, i) => i !== (drop >= 0 ? drop : 0));
    }
    this.tasks = next;
    this.save();
    return task;
  }

  /** A result waiting for its files (or undefined to drop it). */
  setPending(taskId: string, result: TaskResult | undefined): void {
    const { [taskId]: _old, ...rest } = this.pendingResults;
    this.pendingResults = result ? { ...rest, [taskId]: result } : rest;
    this.save();
  }

  pending = (): Readonly<Record<string, TaskResult>> => this.pendingResults;

  putCard(peerId: string, card: PeerCard): void {
    this.cards = { ...this.cards, [peerId]: card };
    this.save();
  }

  // ---- outbox

  waiting(to?: string, now = Date.now()): readonly Outgoing[] {
    return this.outbox.filter((o) => (to === undefined || o.to === to) && o.expiresAt > now);
  }

  /** This task's request still waits for their Mac to acknowledge it. */
  undelivered(taskId: string): boolean {
    return this.outbox.some((o) => o.frame.m.t === 'task_request' && o.frame.m.id === taskId);
  }

  queue(to: string, frame: Outgoing['frame'], sentAt?: number): void {
    if (this.outbox.length >= MAX_OUTBOX) throw new Error('Too many requests are waiting to be delivered; wait for people to come online');
    this.saveOutbox([...this.outbox, { to, frame, expiresAt: Date.now() + OUTBOX_TTL_MS, ...(sentAt ? { sentAt } : {}) }]);
  }

  /** It was handed over (resent later if no ack comes). */
  handed(frameId: string, at = Date.now()): void {
    this.saveOutbox(this.outbox.map((o) => (o.frame.f === frameId ? { ...o, sentAt: at } : o)));
  }

  /** It's in their mailbox. */
  mailed(frameId: string, at = Date.now()): void {
    this.saveOutbox(this.outbox.map((o) => (o.frame.f === frameId ? { ...o, mailedAt: at } : o)));
  }

  /** They got it. */
  acked(from: string, frameId: string): Outgoing | undefined {
    const hit = this.outbox.find((o) => o.frame.f === frameId && o.to === from);
    if (hit) this.saveOutbox(this.outbox.filter((o) => o !== hit));
    return hit;
  }

  /** Drop what waited too long; returns it. */
  expire(now = Date.now()): Outgoing[] {
    const gone = this.outbox.filter((o) => o.expiresAt <= now);
    if (gone.length) this.saveOutbox(this.outbox.filter((o) => o.expiresAt > now));
    return gone;
  }

  /** Forget a task: it, anything still waiting to go for it, and a result waiting for its files. */
  remove(taskId: string): void {
    this.dropTask(taskId);
    this.setPending(taskId, undefined);
    const next = this.tasks.filter((t) => t.id !== taskId);
    if (next.length === this.tasks.length) return;
    this.tasks = next;
    this.save();
  }

  /** Drop what's waiting for one task (it was cancelled before it left). */
  dropTask(taskId: string): void {
    const next = this.outbox.filter((o) => o.frame.m.t === 'card' || o.frame.m.id !== taskId);
    if (next.length !== this.outbox.length) this.saveOutbox(next);
  }

  // ---- folders

  /** The scratch folder a received task runs in. */
  workDir(taskId: string, base: string): string {
    const dir = path.join(this.dir ?? base, 'work', safeName(taskId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** A new path for a file of this task (a safe name, nothing there yet). */
  claimPath(taskId: string, raw: string, base: string): string {
    const dir = path.join(this.dir ?? base, 'files', safeName(taskId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = fileName(raw);
    for (let i = 1; ; i++) {
      const dot = name.lastIndexOf('.');
      const candidate = i === 1 ? name : dot > 0 ? `${name.slice(0, dot)} ${i}${name.slice(dot)}` : `${name} ${i}`;
      const target = path.join(dir, candidate);
      if (!existsSync(target) && !existsSync(`${target}.part`)) return target;
    }
  }

  /** Save the files a result brought (names made safe, at most MAX_FILE_TOTAL bytes). */
  saveFiles(taskId: string, files: readonly ResultFile[], base: string): Array<{ name: string; size: number; path?: string; image?: boolean }> {
    const dir = path.join(this.dir ?? base, 'files', safeName(taskId));
    let budget = MAX_FILE_TOTAL;
    const used = new Set<string>();
    return files.map((f) => {
      const name = uniqueName(fileName(f.name), used);
      const image = f.image ? { image: true } : {};
      if (!f.b64) return { name, size: f.size, ...image };
      const bytes = Buffer.from(f.b64, 'base64');
      if (bytes.length > budget) return { name, size: f.size, ...image };
      budget -= bytes.length;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, name);
      writeFileSync(target, bytes, { mode: 0o600 });
      return { name, size: bytes.length, path: target, ...image };
    });
  }

  private save(): void {
    if (this.dir) writeJson(path.join(this.dir, 'tasks.json'), { version: 1, tasks: this.tasks, cards: this.cards, pending: this.pendingResults });
  }

  private saveOutbox(next: readonly Outgoing[]): void {
    this.outbox = next;
    if (this.dir) writeJson(path.join(this.dir, 'outbox.json'), next);
  }
}

/** A file name from someone else: no folders, no dots in front, nothing odd. */
export function fileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.@+ -]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 120);
  return cleaned || 'file';
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let i = 2; used.has(candidate); i++) {
    const dot = name.lastIndexOf('.');
    candidate = dot > 0 ? `${name.slice(0, dot)} ${i}${name.slice(dot)}` : `${name} ${i}`;
  }
  used.add(candidate);
  return candidate;
}
