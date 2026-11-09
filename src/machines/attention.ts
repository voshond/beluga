/**
 * One bell for every computer (BLG-790), as plain data: a computer's notice shown once through
 * this app (its name on it, Do Not Disturb here silencing it), what it's about tagged with the
 * computer so opening or answering it acts there, and every computer's counts summed for the bell
 * and the Dock. Browser-safe.
 */

/** A notice as a screen is asked to show it (the notify capability's argument). */
export interface RawNotice {
  readonly title: string;
  readonly body: string;
  readonly sound: boolean;
  readonly channel?: string;
  readonly approval?: string;
  readonly task?: string;
  readonly [key: string]: unknown;
}

const TAGGED = /^m:([0-9a-f]{16}):([\s\S]*)$/;

/** What a notice is about (a conversation, a request), on computer `machine`. */
export const tagFor = (machine: string, id: string): string => `m:${machine}:${id}`;

/** Which computer a tagged id is on, and the id there (none: this Mac's). */
export function untag(value: string | undefined): { readonly machine?: string; readonly id?: string } {
  if (value === undefined) return {};
  const m = TAGGED.exec(value);
  return m ? { machine: m[1]!, id: m[2]! } : { id: value };
}

/** A computer's notice as this app shows it: its name in the title, what it's about tagged with it. */
export function machineNotice(machine: { readonly id: string; readonly name: string }, raw: RawNotice): RawNotice {
  return {
    ...raw,
    title: `${machine.name} · ${raw.title}`,
    ...(raw.channel !== undefined ? { channel: tagFor(machine.id, raw.channel) } : {}),
    ...(raw.approval !== undefined ? { approval: tagFor(machine.id, raw.approval) } : {}),
    ...(raw.task !== undefined ? { task: tagFor(machine.id, raw.task) } : {}),
  };
}

/** The item a notice is about, for showing it once however many times it comes (a link dialled again replays). */
export const noticeKey = (machine: string, raw: RawNotice): string => [machine, raw.approval ?? raw.task ?? raw.channel ?? '', raw.title, raw.body].join('\u0000');

/** Each item once within `ttlMs`; the oldest forgotten past `max`. */
export class OnceEach {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly max = 500,
  ) {}

  first(key: string, now = Date.now()): boolean {
    const at = this.seen.get(key);
    if (at !== undefined && now - at < this.ttlMs) return false;
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
}

/** What the bell, the Dock and the menu bar count. */
export interface Counts {
  readonly new: number;
  readonly waiting: number;
  readonly working: number;
}

/** This Mac's counts with every computer's added. */
export function sumCounts(here: Counts, computers: readonly Counts[]): Counts {
  return computers.reduce((a, b) => ({ new: a.new + b.new, waiting: a.waiting + b.waiting, working: a.working + b.working }), here);
}
