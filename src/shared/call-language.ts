/**
 * The language a call is in (BLG-738). Whisper, left to tell the language itself, decides again on
 * every phrase, and a short phrase is easy to mistake: two seconds of Turkish come out as Russian.
 * People in a call speak one language, so the call settles on one: each Mac counts how many
 * seconds of its phrases came out in which language, says so with its scribe status, and once one
 * language clearly leads across everyone, every phrase from then on is written down in it. Pure,
 * so every Mac settles on the same one.
 */

/** Seconds of speech heard in each language (ISO 639-1 codes: "tr", "en"). */
export type LanguageCount = Readonly<Record<string, number>>;

/** Speech it takes before a call's language is trusted. */
export const SETTLE_SECONDS = 8;
/** The leading language's share of all speech, for it to be the call's. */
export const SETTLE_SHARE = 0.6;
/** Most languages a Mac reports (the rest is noise). */
const MAX_REPORTED = 4;

/** A language code as the voice models give it, or undefined for anything else. */
export function languageCode(v: unknown): string | undefined {
  return typeof v === 'string' && /^[a-z]{2,3}$/.test(v) ? v : undefined;
}

/** One more phrase heard in `lang`, `seconds` long. */
export function countPhrase(count: LanguageCount, lang: string | undefined, seconds: number): LanguageCount {
  const code = languageCode(lang);
  if (!code || !(seconds > 0)) return count;
  return { ...count, [code]: (count[code] ?? 0) + seconds };
}

/** What a Mac reports: its leading languages, rounded to tenths of a second. */
export function reported(count: LanguageCount): LanguageCount {
  return Object.fromEntries(
    Object.entries(count)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, MAX_REPORTED)
      .map(([l, s]) => [l, Math.round(s * 10) / 10]),
  );
}

/** Everyone's counts together. */
export function addCounts(counts: readonly LanguageCount[]): LanguageCount {
  const out: Record<string, number> = {};
  for (const c of counts) for (const [l, s] of Object.entries(c)) if (languageCode(l) && s > 0 && Number.isFinite(s)) out[l] = (out[l] ?? 0) + s;
  return out;
}

/** The call's language, once enough was heard and one clearly leads; undefined until then. */
export function callLanguage(counts: readonly LanguageCount[]): string | undefined {
  const all = Object.entries(addCounts(counts)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const total = all.reduce((n, [, s]) => n + s, 0);
  const lead = all[0];
  if (!lead || total < SETTLE_SECONDS || lead[1] / total < SETTLE_SHARE) return undefined;
  return lead[0];
}

/**
 * The language to write a phrase of yours down in: the one you set in Voice settings if you set
 * one, else the call's once it settled, else the model tells ('auto').
 */
export function phraseLanguage(pref: string, settled: string | undefined): string {
  if (pref !== 'auto' && languageCode(pref)) return pref;
  return settled ?? 'auto';
}
