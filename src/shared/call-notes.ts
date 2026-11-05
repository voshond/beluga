import type { CallNotesView, NotesLine } from './calls.js';

/**
 * Reading a call's notes (BLG-715), which can run for hours: turns (one person's phrases in a
 * row), search, and the timeline's segments. Pure, so the reader and the tests share it.
 */

export interface Turn {
  readonly by: string;
  readonly name: string;
  readonly at: number;
  /** When the last phrase of it was said. */
  readonly until: number;
  readonly text: string;
}

/** Phrases said one after another by the same person read as one turn (a long pause starts a new one). */
export function turns(lines: readonly NotesLine[]): Turn[] {
  const out: Turn[] = [];
  for (const l of lines) {
    const last = out.at(-1);
    if (last && last.by === l.by && l.at - last.until < 90_000) out[out.length - 1] = { ...last, until: l.at, text: `${last.text} ${l.text}` };
    else out.push({ by: l.by, name: l.name, at: l.at, until: l.at, text: l.text });
  }
  return out;
}

/** "4:05", "1:02:09": how far into the call. */
export function clockOf(start: number, at: number): string {
  const s = Math.max(0, Math.round((at - start) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "under a minute", "47 min", "1 h 12 min". */
export function lengthOf(v: Pick<CallNotesView, 'startedAt' | 'endedAt'>): string {
  const m = Math.round((v.endedAt - v.startedAt) / 60_000);
  if (m < 1) return 'under a minute';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** How many words were said. */
export const wordCount = (lines: readonly NotesLine[]): number => lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);

/** The turns that say all of `query`'s words (any case), by index. */
export function findTurns(all: readonly Turn[], query: string): number[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return all.flatMap((t, i) => {
    const text = t.text.toLowerCase();
    return words.every((w) => text.includes(w)) ? [i] : [];
  });
}

/** Text cut into what matches the search and what doesn't (for highlighting). */
export function marks(text: string, query: string): Array<{ readonly text: string; readonly hit: boolean }> {
  const words = query.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return [{ text, hit: false }];
  return text
    .split(new RegExp(`(${words.join('|')})`, 'gi'))
    .filter((p) => p !== '')
    .map((p) => ({ text: p, hit: words.some((w) => new RegExp(`^${w}$`, 'i').test(p)) }));
}

/** Each turn on the call's timeline: where it starts and how long it lasts, in fractions of the call. */
export function timeline(v: Pick<CallNotesView, 'startedAt' | 'endedAt'>, all: readonly Turn[]): Array<{ readonly index: number; readonly by: string; readonly from: number; readonly width: number }> {
  const span = Math.max(1, v.endedAt - v.startedAt);
  return all.map((t, index) => {
    const from = Math.min(1, Math.max(0, (t.at - v.startedAt) / span));
    // A turn is at least a sliver wide, and runs a few seconds past its last phrase.
    const width = Math.max(0.004, Math.min(1 - from, (t.until + 4_000 - t.at) / span));
    return { index, by: t.by, from, width };
  });
}

/** Where a marker every few minutes goes ("10:00"), so a long call has landmarks. */
export function minuteMarks(v: Pick<CallNotesView, 'startedAt' | 'endedAt'>): number[] {
  const minutes = (v.endedAt - v.startedAt) / 60_000;
  const every = minutes <= 20 ? 5 : minutes <= 90 ? 15 : 30;
  const out: number[] = [];
  for (let m = every; m < minutes; m += every) out.push(m);
  return out;
}
