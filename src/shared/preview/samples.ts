import { type Field, type Shape, choicesOf, required } from './shape.js';

/**
 * Believable props for a component, worked out from each prop's type and name, never by asking a
 * model: a `title` gets a title, an `email` an address, `members: User[]` three people, a
 * `number[][]` a 2×3 grid, `onSelect` a stub that tells the preview it fired. The same component
 * always gets the same values. Browser-safe.
 *
 * What can't travel as JSON is marked and made real in the preview (preview/runtime.ts): a function
 * is `{ "$beluga": "fn", "name": "onSelect" }`, a date `{ "$beluga": "date", "iso": "…" }`.
 */

export const MARK = '$beluga';
export type FnMark = { readonly [MARK]: 'fn'; readonly name: string };
export type DateMark = { readonly [MARK]: 'date'; readonly iso: string };

export const fnMark = (name: string): FnMark => ({ [MARK]: 'fn', name });
export const dateMark = (iso: string): DateMark => ({ [MARK]: 'date', iso });
export const isMark = (v: unknown, kind: 'fn' | 'date'): boolean => Boolean(v && typeof v === 'object' && (v as Record<string, unknown>)[MARK] === kind);

const PEOPLE = ['Mia Chen', 'Leo Park', 'Ava Stone', 'Noah Reyes', 'Zoe Kim', 'Ezra Cole'];
const WORDS = ['Overview', 'Billing', 'Team', 'Reports', 'Settings', 'Activity'];
const SENTENCES = [
  'A short line that reads like the real thing.',
  'Everything you need to get started, in one place.',
  'Updated a moment ago by the team.',
  'Plenty of room for a longer description here.',
];
const PASTELS = ['#b8d4f0', '#f5c6d6', '#c8e6c9', '#ffe0b2', '#d1c4e9', '#b2ebf2'];
/** The day every sample date is counted from, so previews never change by themselves. */
const BASE_DAY = Date.UTC(2026, 10, 8, 9, 30);

/** Words of a name: "avatarUrl" → ["avatar", "url"]. */
const words = (name: string): string[] =>
  name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

const titleCase = (name: string): string => {
  const w = words(name).join(' ');
  return w ? w[0]!.toUpperCase() + w.slice(1) : name;
};

const has = (name: string, re: RegExp): boolean => re.test(words(name).join(' '));

/** A small picture with no network: soft colour and initials, as SVG. */
export function placeholderSvg(seed: number, text = '', w = 160, h = 160): string {
  const a = PASTELS[seed % PASTELS.length]!;
  const b = PASTELS[(seed + 2) % PASTELS.length]!;
  const safe = text.replace(/[^A-Za-z0-9]/g, '').slice(0, 3);
  const label = safe ? `<text x="50%" y="54%" font-family="-apple-system,system-ui,sans-serif" font-size="${Math.round(Math.min(w, h) * 0.32)}" font-weight="600" fill="#4a4560" text-anchor="middle" dominant-baseline="middle">${safe}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${label}</svg>`;
}

/** The same picture as a data URL (a thumbnail beside its prop). */
export const placeholderImage = (seed: number, text = ''): string => `data:image/svg+xml;utf8,${encodeURIComponent(placeholderSvg(seed, text))}`;

/**
 * A sample picture's address: a short name the preview's server draws (picture/2-LP.svg), so a
 * prop reads like a file and never as a wall of data.
 */
export const PICTURE = /^picture\/(\d+)-([A-Za-z0-9]{0,3})\.svg$/;
export const samplePicture = (seed: number, text: string): string => `picture/${seed}-${text.replace(/[^A-Za-z0-9]/g, '').slice(0, 3)}.svg`;

/** A sample picture's own drawing, for a thumbnail; undefined for anything else. */
export function pictureOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = PICTURE.exec(value);
  if (m) return placeholderImage(Number(m[1]), m[2]);
  return value.startsWith('data:image/') ? value : undefined;
}

const initials = (name: string): string =>
  name
    .split(' ')
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** A string for a prop named `name` (the i-th of a list). */
function sampleString(name: string, i: number, inList = false): string {
  const person = PEOPLE[i % PEOPLE.length]!;
  if (has(name, /\b(e ?mail)\b/)) return `${person.split(' ')[0]!.toLowerCase()}@example.com`;
  if (has(name, /\b(avatar|image|img|photo|picture|thumbnail|cover|logo|src|icon url)\b/)) return samplePicture(i, initials(person));
  if (has(name, /\b(url|href|link|website)\b/)) return 'https://example.com';
  if (has(name, /\b(first name)\b/)) return person.split(' ')[0]!;
  if (has(name, /\b(last name|surname)\b/)) return person.split(' ')[1]!;
  if (has(name, /\b(user ?name|handle)\b/)) return `@${person.split(' ')[0]!.toLowerCase()}`;
  if (has(name, /\b(author|owner|user|person|assignee|name|full name|display name)\b/)) return person;
  if (has(name, /\b(id|key|slug)\b/)) return `item-${i + 1}`;
  if (has(name, /\b(colou?r|bg|background|tint|accent|fill|stroke)\b/)) return PASTELS[i % PASTELS.length]!;
  if (has(name, /\b(date|day|at|time|created|updated|due|deadline)\b/)) return new Date(BASE_DAY - i * 86_400_000).toISOString().slice(0, 10);
  if (has(name, /\b(phone|tel)\b/)) return '+1 415 555 0134';
  if (has(name, /\b(price|amount|cost|total)\b/)) return `$${[24, 12, 48][i % 3]}`;
  if (has(name, /\b(status|state)\b/)) return ['active', 'pending', 'done'][i % 3]!;
  if (has(name, /\b(placeholder|hint)\b/)) return 'Type here…';
  if (has(name, /\b(description|desc|body|content|message|text|summary|bio|subtitle|caption|excerpt|detail|details)\b/)) return SENTENCES[i % SENTENCES.length]!;
  if (has(name, /\b(cta|button|action|submit|confirm|cancel)\b/) || has(name, /\b(button|cta) (text|label)\b/)) return ['Get started', 'Learn more', 'Continue'][i % 3]!;
  if (has(name, /\b(title|heading|header|headline)\b/)) return ['Quarterly report', 'Welcome back', 'Your plan'][i % 3]!;
  if (has(name, /\b(label|tab|tag|category|word|option)\b/)) return WORDS[i % WORDS.length]!;
  if (has(name, /\b(class ?name|style|class)\b/)) return '';
  if (has(name, /\b(address|location|city)\b/)) return ['Lisbon', 'Istanbul', 'Seoul'][i % 3]!;
  if (has(name, /\b(currency)\b/)) return 'USD';
  return inList ? `${titleCase(name)} ${i + 1}` : titleCase(name);
}

/** A number for a prop named `name` (the i-th of a list). */
function sampleNumber(name: string, i: number): number {
  if (has(name, /\b(ratio|fraction|opacity|alpha)\b/)) return [0.6, 0.35, 0.8][i % 3]!;
  if (has(name, /\b(percent|percentage|progress|pct|score)\b/)) return [64, 38, 82][i % 3]!;
  if (has(name, /\b(rating|stars)\b/)) return [4, 5, 3][i % 3]!;
  if (has(name, /\b(price|amount|cost|total|revenue|balance)\b/)) return [24, 12, 48][i % 3]!;
  if (has(name, /\b(year)\b/)) return 2026 - i;
  if (has(name, /\b(age)\b/)) return [32, 27, 41][i % 3]!;
  if (has(name, /\b(width|height|size|radius)\b/)) return [240, 160, 320][i % 3]!;
  if (has(name, /\b(page|step|index|current|active|selected)\b/)) return i;
  if (has(name, /\b(max|limit|capacity)\b/)) return 100;
  if (has(name, /\b(min)\b/)) return 0;
  if (has(name, /\b(count|total|views|likes|items|users|number|num|qty|quantity)\b/)) return [12, 7, 31][i % 3]!;
  return [3, 5, 8][i % 3]!;
}

/** A boolean: off, except what a component only shows when on (a modal's `open`). */
function sampleBoolean(name: string): boolean {
  return has(name, /^(is )?(open|opened|visible|show|shown|expanded|active|checked|selected|enabled|on)\b/) || has(name, /^show /);
}

/** How many items a list gets. */
const LIST = 3;

/** Plural-looking names whose type is unknown: rows of something with an id and a label. */
const LISTY = /\b(items|rows|data|list|options|entries|records|results|users|members|people|tags|tabs|steps|links|cards|products|plans|messages|notifications|events|tasks)\b/;

/** A value for one shape. `name` is the prop's (or an item's field's) name; `i`, its place in a list. */
export function sampleValue(shape: Shape, name: string, i = 0, depth = 0, inList = false): unknown {
  if (depth > 6) return undefined;
  const s = required(shape);
  switch (s.kind) {
    case 'string':
      return sampleString(name, i, inList);
    case 'number':
      return sampleNumber(name, i);
    case 'boolean':
      return sampleBoolean(name);
    case 'node':
      return has(name, /^children$/) ? ['Get started', 'Learn more', 'Continue'][i % 3] : sampleString(name, i);
    case 'function':
      return fnMark(name);
    case 'date':
      return dateMark(new Date(BASE_DAY - i * 86_400_000).toISOString());
    case 'literal':
      return s.value;
    case 'union': {
      const choices = choicesOf(s);
      if (choices) return choices[i % choices.length];
      // A union of kinds (string | number…): the first that can be filled.
      for (const o of s.of) {
        const v = sampleValue(o, name, i, depth + 1, inList);
        if (v !== undefined) return v;
      }
      return undefined;
    }
    case 'array': {
      // A grid: 2 rows of 3 (number[][], or a matrix of anything).
      if (s.of.kind === 'array') return Array.from({ length: 2 }, (_, r) => Array.from({ length: 3 }, (_, c) => (s.of.kind === 'array' && s.of.of.kind === 'number' ? r * 3 + c + 1 : sampleValue(s.of.kind === 'array' ? s.of.of : s.of, name, r * 3 + c, depth + 1))));
      const item = singular(name);
      return Array.from({ length: LIST }, (_, k) => sampleValue(s.of, item, i * LIST + k, depth + 1, true)).filter((v) => v !== undefined);
    }
    case 'tuple':
      // A row of numbers counts on from the rows before it ([[1, 2, 3], [4, 5, 6]]); anything else is the k-th of its kind.
      if (s.of.every((item) => item.kind === 'number')) return s.of.map((_, k) => i * s.of.length + k + 1);
      return s.of.map((item, k) => sampleValue(item, name, k, depth + 1));
    case 'object':
      return sampleObject(s.fields, i, depth + 1);
    case 'record':
      return Object.fromEntries(['first', 'second', 'third'].map((k, n) => [k, sampleValue(s.of, k, n, depth + 1)]));
    case 'unknown':
      return sampleUnknown(name, i, depth, inList);
  }
}

/** "members" → "member": an item of a list is named like one. */
const singular = (name: string): string => (/ies$/.test(name) ? name.replace(/ies$/, 'y') : /ss$/.test(name) ? name : name.replace(/s$/, ''));

/** A type it couldn't read (JavaScript, an import): the name says what it likely is, or nothing. */
function sampleUnknown(name: string, i: number, depth: number, inList: boolean): unknown {
  if (/^on[A-Z]/.test(name) || has(name, /\b(handler|callback)\b/)) return fnMark(name);
  if (/^(is|has|can|should|show)[A-Z]/.test(name) || has(name, /^(disabled|loading|open|checked|selected|visible|active|expanded|required|readonly|read only)$/)) return sampleBoolean(name);
  if (has(name, /^(class name|style|ref|as|as child|key|variant|size|type)$/)) return undefined;
  if (depth < 2 && has(name, LISTY)) {
    return Array.from({ length: LIST }, (_, k) => ({ id: `item-${k + 1}`, label: WORDS[k % WORDS.length]!, description: SENTENCES[k % SENTENCES.length]! }));
  }
  if (has(name, /\b(count|total|amount|price|value|width|height|percent|progress|rating|age|year|index|max|min)\b/)) return sampleNumber(name, i);
  if (has(name, /\b(children)\b/)) return 'Get started';
  return sampleString(name, i, inList);
}

function sampleObject(fields: readonly Field[], i: number, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = f.fallback !== undefined ? f.fallback : sampleValue(f.shape, f.name, i, depth);
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

/**
 * Whether a top-level prop gets a sample when the component may do without: data and callbacks
 * do (a list, a title, onClick, so the preview has something to draw and to report), switches and
 * slots don't (a `disabled?` stays off, an `icon?` stays empty) and its own defaults win.
 */
function fillsOptional(f: Field): boolean {
  if (f.fallback !== undefined) return false;
  const s = required(f.shape);
  if (s.kind === 'function') return true;
  if (s.kind === 'unknown') return /^on[A-Z]/.test(f.name) || has(f.name, LISTY) || has(f.name, /^(title|label|name|text|children|description|value)$/);
  if (s.kind === 'boolean' || s.kind === 'node' || s.kind === 'union' || s.kind === 'literal') return f.name === 'children';
  return true;
}

/** Props for a component: Claude's own (`given`) win, the rest are filled from the types. */
export function sampleProps(fields: readonly Field[], given: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.name in given) continue;
    if (f.optional && !fillsOptional(f)) continue;
    // A required prop with a default of its own still gets it (the control shows it).
    const v = f.fallback !== undefined ? f.fallback : sampleValue(f.shape, f.name);
    if (v !== undefined) out[f.name] = v;
  }
  return { ...out, ...given };
}
