import { type BeforeSince, type ScopeChange, type SuccessFile, type SuccessMetric, VERDICT_WORDS, formatSuccessNumber, verdictOf } from './success.js';

export type SuccessNumbers = Readonly<Record<string, BeforeSince>>;

const metricLine = (m: SuccessMetric, n: BeforeSince | undefined, shipped: boolean): string => {
  const f = (v: number | undefined): string => formatSuccessNumber(v, m.unit);
  const now = shipped ? `before ${f(n?.before)} (${n?.beforeCount ? `${n.beforeCount} kept` : 'the baseline'}), since ${f(n?.since)} (${n?.sinceCount ?? 0} kept), latest ${f(n?.latest)}` : `latest ${f(n?.latest)}`;
  const verdict = VERDICT_WORDS[verdictOf(shipped ? (n?.since ?? n?.latest) : n?.latest, m)];
  return `- ${m.label} (${m.name}, ${m.direction === 'up' ? 'higher' : 'lower'} is better): baseline ${f(m.baseline)} over ${m.baselineWindow || 'the window before delivery'}, target ${f(m.target)}; ${now}; ${verdict}. Counts: ${m.attribution} (filter: ${m.filter})`;
};

export const OUTCOME_REVIEW = [
  'It shipped, so each check-in is now a weekly outcome review: besides the usual check-in, compare each success metric before and since the ship date with the numbers below (its sentinel keeps them).',
  'Give each metric a verdict (target met, improving, no change, worse, or too early when fewer than two numbers were kept since shipping) and one overall, with the numbers.',
  'Write it on top of timeline.md as "- <today> [check-in]: Outcome review: <overall verdict>: <metric> <before> → <since>; …", and in brief.md under "## Outcome".',
  'When a metric is worse or flat after four weeks, make a suggestion about it (what to look into, who to ask).',
].join(' ');

/** The success part of an initiative's brief: what it means, the numbers so far, a scope change to revisit, the outcome review once shipped. */
export const successBrief = (file: SuccessFile, numbers: SuccessNumbers, scope: ScopeChange | undefined, checkIn: boolean): string => {
  const def = file.definition;
  if (!def) return '\n\nSuccess: not defined yet. The owner defines it from the page (Success › Define Success); do not write success.json yourself.';
  const shipped = Boolean(file.shippedAt);
  const lines = [
    `\n\nSuccess, as the owner accepted it on ${def.at.slice(0, 10)} (success.json: Beluga writes it, never change it):`,
    def.summary,
    ...def.metrics.map((m) => metricLine(m, numbers[m.name], shipped)),
    def.sentinel ? `Its sentinel \`sentinel:${def.sentinel}\` keeps these numbers${def.dashboard ? ', and its dashboard shows them' : ''}.` : '',
    shipped ? `Shipped on ${file.shippedAt!.slice(0, 10)}.` : '',
    scope
      ? `Scope changed since success was defined (tickets added: ${scope.added.join(', ') || 'none'}; gone: ${scope.removed.join(', ') || 'none'}): unless one is open already, make one suggestion, kind "decision" with options ["Revisit the success definition", "Keep it"], saying how the change bears on the metrics.`
      : '',
    shipped && checkIn ? OUTCOME_REVIEW : '',
  ];
  return lines.filter(Boolean).join('\n');
};
