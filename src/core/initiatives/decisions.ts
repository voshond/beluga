import { suggestionHistory } from './log.js';
import { type InitiativeView, type Suggestion, isDecision } from './model.js';

/** One bullet of decisions.md: "- 2026-11-25: … Why: …", the day and the reason optional. */
export type DecisionNote = {
  readonly day: string;
  readonly text: string;
  readonly why?: string;
  readonly source?: string;
  readonly question?: true;
  /** The suggestion it records ("(suggestion 3)"), when it names one. */
  readonly suggestion?: number;
  /** The plain line above it in its section ("Waiting on stakeholders:"), if any. */
  readonly group?: string;
};

/** decisions.md's "## Open" questions (waiting on someone else) and "## Decided" ones. */
export type DecisionNotes = {
  readonly open: readonly DecisionNote[];
  readonly decided: readonly DecisionNote[];
};

const MAX_NOTES = 200;

const HEADING = /^##\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
const LEADING_DAY = /^\**\s*(\d{4}-\d{2}-\d{2})\s*\**\s*[:–—-]\s*/;
const TRAILING_DAY = /\s*\((?:[^()]*?\s)?(\d{4}-\d{2}-\d{2})\)\s*\.?$/;
const SUGGESTION_REF = /\s*\(suggestion\s+#?(\d+)\)/i;
const WHY = /\s*\bWhy:\s*/;

const sectionOf = (title: string): keyof DecisionNotes | undefined => {
  const word = title.toLowerCase().replace(/[^a-z]/g, '');
  if (word === 'open') return 'open';
  if (word === 'decided') return 'decided';
  return undefined;
};

const noteOf = (line: string, group: string | undefined): DecisionNote => {
  let rest = line;
  const leading = LEADING_DAY.exec(rest);
  if (leading) rest = rest.slice(leading[0].length);
  const trailing = leading ? undefined : TRAILING_DAY.exec(rest);
  if (trailing) rest = rest.slice(0, trailing.index);
  const ref = SUGGESTION_REF.exec(rest);
  if (ref) rest = rest.replace(SUGGESTION_REF, '');
  const [text = '', ...why] = rest.split(WHY);
  const reason = why.join(' Why: ').trim();
  return {
    day: leading?.[1] ?? trailing?.[1] ?? '',
    text: text.replace(/\*\*/g, '').trim(),
    ...(reason ? { why: reason } : {}),
    ...(ref ? { suggestion: Number(ref[1]) } : {}),
    ...(group ? { group } : {}),
  };
};

/**
 * decisions.md as the page shows it. Undefined when it has neither an "## Open" nor a "## Decided"
 * heading: the agent wrote it some other way, and the page only lists it among the memory files.
 */
export const decisionsOf = (markdown: string): DecisionNotes | undefined => {
  const notes: Record<keyof DecisionNotes, Array<{ line: string; group?: string }>> = { open: [], decided: [] };
  let section: keyof DecisionNotes | undefined;
  let seen = false;
  let group: string | undefined;
  for (const raw of markdown.split('\n')) {
    const heading = HEADING.exec(raw);
    if (heading) {
      section = sectionOf(heading[1]!);
      seen ||= section !== undefined;
      group = undefined;
      continue;
    }
    if (!section || !raw.trim() || /^#/.test(raw)) continue;
    const bullet = BULLET.exec(raw);
    const last = notes[section].at(-1);
    if (bullet && !/^\s/.test(raw)) notes[section].push({ line: bullet[1]!, ...(group ? { group } : {}) });
    else if (/^\s/.test(raw) && last) last.line = `${last.line} ${(bullet?.[1] ?? raw).trim()}`;
    else if (!bullet) group = raw.trim().replace(/:$/, '');
  }
  if (!seen) return undefined;
  const parse = (list: ReadonlyArray<{ line: string; group?: string }>): DecisionNote[] => list.slice(0, MAX_NOTES).map((n) => noteOf(n.line, n.group)).filter((n) => n.text);
  return { open: parse(notes.open), decided: parse(notes.decided) };
};

const STOP_WORDS: ReadonlySet<string> = new Set(['about', 'after', 'also', 'before', 'from', 'have', 'into', 'just', 'like', 'only', 'should', 'that', 'their', 'them', 'then', 'there', 'they', 'this', 'what', 'when', 'which', 'will', 'with', 'would', 'yeah']);

const wordsOf = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w)));

const DAY = 86_400_000;

const nearDay = (day: string, iso: string | undefined): boolean => {
  const a = Date.parse(day);
  const b = Date.parse((iso ?? '').slice(0, 10));
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= DAY;
};

const SHARED_WORDS = 2;

/** Words in more than this many settled notes are the initiative's own vocabulary ("enrollment", "customer"), not what a note is about. */
const COMMON_IN = 2;

type Pair = { readonly note: number; readonly suggestion: number; readonly score: number };

/**
 * The settled notes that record a suggestion the log already shows: the one it names ("(suggestion 3)"),
 * else, for an older line, the decision resolved within a day whose words it shares most. Each decision
 * pairs with one note at most.
 */
export const recordedNotes = (notes: readonly DecisionNote[], suggestions: readonly Suggestion[]): Set<number> => {
  const resolved = suggestions.filter((s) => s.state === 'approved');
  const named = new Set(notes.flatMap((n, i) => (n.suggestion !== undefined && resolved.some((s) => s.id === n.suggestion) ? [i] : [])));
  const taken = new Set(notes.flatMap((n) => (n.suggestion !== undefined ? [n.suggestion] : [])));
  const words = notes.map((n) => wordsOf(n.text));
  const seen = new Map<string, number>();
  for (const set of words) for (const w of set) seen.set(w, (seen.get(w) ?? 0) + 1);
  const pairs: Pair[] = notes.flatMap((note, i) =>
    named.has(i) || note.suggestion !== undefined
      ? []
      : resolved
          .filter((s) => isDecision(s) && !taken.has(s.id) && nearDay(note.day, s.resolvedAt))
          .map((s) => ({ note: i, suggestion: s.id, score: [...wordsOf(`${s.text} ${s.answer ?? ''}`)].filter((w) => words[i]!.has(w) && (seen.get(w) ?? 0) <= COMMON_IN).length }))
          .filter((p) => p.score >= SHARED_WORDS),
  );
  const paired = new Set(named);
  for (const pair of pairs.sort((a, b) => b.score - a.score)) {
    if (paired.has(pair.note) || taken.has(pair.suggestion)) continue;
    paired.add(pair.note);
    taken.add(pair.suggestion);
  }
  return paired;
};

/** The Decided notes the decision log adds: those that aren't a suggestion it already shows. */
export const settledNotes = (item: Pick<InitiativeView, 'suggestions' | 'decisions'>): DecisionNote[] => {
  const notes = item.decisions?.decided ?? [];
  const legacy = notes.filter((note) => !note.question);
  const recorded = recordedNotes(legacy, item.suggestions);
  return [...legacy.filter((_, i) => !recorded.has(i)), ...notes.filter((note) => note.question)];
};

export type LogEntry = { readonly kind: 'suggestion'; readonly suggestion: Suggestion; readonly day: string } | { readonly kind: 'note'; readonly note: DecisionNote; readonly day: string };

/** The decision log: resolved suggestions and decisions.md's settled notes, the latest first. */
export const decisionLog = (item: Pick<InitiativeView, 'suggestions' | 'decisions'>): LogEntry[] => {
  const suggestions = suggestionHistory(item).map((suggestion): LogEntry => ({ kind: 'suggestion', suggestion, day: suggestion.resolvedAt ?? '' }));
  const notes = settledNotes(item).map((note): LogEntry => ({ kind: 'note', note, day: note.day }));
  return [...suggestions, ...notes].sort((a, b) => b.day.localeCompare(a.day));
};
