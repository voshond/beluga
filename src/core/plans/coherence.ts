import { type Decided, type PlanBody, decisionText, type PlanMilestone, type PlanTask, allTasks, milestoneDeps } from './model.js';

/**
 * Cheap checks of a plan after every change (BLG-772): what plan_write and plan_update answer next
 * to "Saved", so drift shows the moment it's made. Tasks with near-identical titles or goals, tasks
 * in milestones that run side by side sharing files, text naming ids that were just removed,
 * blockers dropped with a removed task, milestones left empty, and tasks still written the way of
 * a superseded decision (or with a word a decision retired). Warnings only: the plan is saved.
 * The deep read is the reviewer's, once, before approval (draft-review.ts). Browser-safe.
 */

/** How many warnings an answer lists (the rest counted). */
export const MAX_WARNINGS = 12;

const STOP = new Set('a an the and or to of for in on with from by it its is be as at into this that their your our so via when then than not no new'.split(' '));

/** A word without its plural or third-person ending ("reaches" → "reach", "tasks" → "task"). */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (/(ch|sh|ss|x|z)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/** A text's words, for comparing: lower case, no small words, plurals folded. */
function words(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of (text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w || STOP.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

/** How alike two word sets are (Dice: 1 is the same words). */
function alike(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  return (2 * both) / (a.size + b.size);
}

const TITLE_ALIKE = 0.8;
const GOAL_ALIKE = 0.75;
/** Goals shorter than this many words aren't compared (too little to tell). */
const GOAL_MIN_WORDS = 5;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` uses `term` as a word (any case; a plural too). */
export function usesTerm(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(t)}(e?s)?(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Whether `text` names an id: a dashed or numbered id as a word, any id in backticks or brackets. */
function namesId(text: string, id: string): boolean {
  const quoted = new RegExp(`[\`\\[]${escape(id)}[\`\\]]`).test(text);
  if (quoted) return true;
  if (!/[-\d]/.test(id)) return false;
  return new RegExp(`(^|[^a-z0-9-])${escape(id)}(?=$|[^a-z0-9-])`, 'i').test(text);
}

/** Everything a task says, as one text (title, goal, context, acceptance). */
const taskText = (t: PlanTask): string => [t.title, t.goal ?? '', t.context ?? '', ...t.acceptance].join('\n');
const milestoneText = (m: PlanMilestone): string => [m.title, m.goal ?? '', ...m.criteria].join('\n');

const name = (t: PlanTask): string => `[${t.id}] “${t.title}”`;
const mName = (m: PlanMilestone): string => `[${m.id}] “${m.title}”`;

/** Every milestone each one waits on, directly or not. */
function before(body: PlanBody): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const byId = new Map(body.milestones.map((m) => [m.id, m]));
  const walk = (id: string, into: Set<string>): void => {
    const m = byId.get(id);
    if (!m) return;
    for (const d of milestoneDeps(body, m)) if (!into.has(d)) (into.add(d), walk(d, into));
  };
  for (const m of body.milestones) {
    const into = new Set<string>();
    walk(m.id, into);
    out.set(m.id, into);
  }
  return out;
}

/** Every task each one waits on, directly or not. */
function waitsOn(body: PlanBody): Map<string, Set<string>> {
  const byId = new Map(allTasks(body).map((t) => [t.task.id, t.task]));
  const out = new Map<string, Set<string>>();
  const walk = (id: string, into: Set<string>): void => {
    for (const b of byId.get(id)?.blockedBy ?? []) if (!into.has(b)) (into.add(b), walk(b, into));
  };
  for (const id of byId.keys()) {
    const into = new Set<string>();
    walk(id, into);
    out.set(id, into);
  }
  return out;
}

const sharedPaths = (a: readonly string[] | undefined, b: readonly string[] | undefined): string[] => (a ?? []).filter((x) => (b ?? []).some((y) => x === y || x.startsWith(`${y.replace(/\/+$/, '')}/`) || y.startsWith(`${x.replace(/\/+$/, '')}/`)));

/** Tasks that look like the same work: near-identical titles, or goals. */
function duplicates(body: PlanBody): string[] {
  const tasks = allTasks(body).map((t) => ({ task: t.task, title: words(t.task.title), goal: words(t.task.goal) }));
  const out: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]!;
      const b = tasks[j]!;
      // A sub-task naturally echoes its parent.
      if (a.task.parent === b.task.id || b.task.parent === a.task.id) continue;
      const sameTitle = alike(a.title, b.title) >= TITLE_ALIKE;
      const sameGoal = a.goal.size >= GOAL_MIN_WORDS && b.goal.size >= GOAL_MIN_WORDS && alike(a.goal, b.goal) >= GOAL_ALIKE;
      if (sameTitle || sameGoal) out.push(`${name(a.task)} and ${name(b.task)} look like the same work (${sameTitle ? 'near-identical titles' : 'near-identical goals'}): keep one, or say in each how they differ.`);
    }
  }
  return out;
}

/** Tasks in milestones that run side by side, touching the same files. */
function sharedTouches(body: PlanBody): string[] {
  const deps = before(body);
  const waits = waitsOn(body);
  const all = allTasks(body);
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      // One milestone's tasks are done one after another by its one agent.
      if (a.milestone.id === b.milestone.id) continue;
      if (deps.get(a.milestone.id)?.has(b.milestone.id) || deps.get(b.milestone.id)?.has(a.milestone.id)) continue;
      if (waits.get(a.task.id)?.has(b.task.id) || waits.get(b.task.id)?.has(a.task.id)) continue;
      const shared = sharedPaths(a.task.touches, b.task.touches);
      if (shared.length) out.push(`${name(a.task)} and ${name(b.task)} both touch ${shared.join(', ')}, in milestones that run side by side: put them in one milestone, or make one wait on the other (depends_on or blocked_by).`);
    }
  }
  return out;
}

/** Milestones with no tasks. */
const emptyMilestones = (body: PlanBody): string[] => body.milestones.filter((m) => !m.tasks.length).map((m) => `Milestone ${mName(m)} has no tasks: add its tasks, or remove it.`);

/** What the plan's text says, part by part (for finding words in it). */
function texts(body: PlanBody): Array<{ readonly who: string; readonly id: string; readonly text: string }> {
  return [
    { who: 'the plan’s goal', id: '', text: `${body.title}\n${body.goal}` },
    ...body.milestones.map((m) => ({ who: `milestone ${mName(m)}`, id: m.id, text: milestoneText(m) })),
    ...allTasks(body).map((t) => ({ who: name(t.task), id: t.task.id, text: taskText(t.task) })),
  ];
}

/** Ids that were in the plan before this change and are gone, still named in its text; blockers dropped with them. */
function danglingRefs(body: PlanBody, previous: PlanBody | undefined): string[] {
  if (!previous) return [];
  const now = new Set([...body.milestones.map((m) => m.id), ...allTasks(body).map((t) => t.task.id)]);
  const gone = [...new Set([...previous.milestones.map((m) => m.id), ...allTasks(previous).map((t) => t.task.id)])].filter((id) => !now.has(id));
  const out: string[] = [];
  for (const id of gone) {
    const using = texts(body).filter((x) => x.id !== id && namesId(x.text, id));
    if (using.length) out.push(`"${id}" is no longer in the plan, but ${using.map((x) => x.who).join(', ')} still ${using.length === 1 ? 'names' : 'name'} it: say what it means now.`);
  }
  // A task that waited on one that went: Beluga dropped the blocker, so it may now start too early.
  const was = new Map(allTasks(previous).map((t) => [t.task.id, t.task]));
  for (const { task } of allTasks(body)) {
    const dropped = (was.get(task.id)?.blockedBy ?? []).filter((b) => !now.has(b));
    if (dropped.length) out.push(`${name(task)} waited on ${dropped.join(', ')}, which ${dropped.length === 1 ? 'was' : 'were'} removed: check what it builds on now (blocked_by).`);
  }
  return out;
}

/** Text still following a superseded decision, or using a word a decision retired. */
function staleDecisions(body: PlanBody, previous: PlanBody | undefined): string[] {
  const list = body.decisions ?? [];
  const byId = new Map(list.map((d) => [d.id, d]));
  const was = new Map((previous?.decisions ?? []).map((d) => [d.id, d]));
  const parts = texts(body);
  const out: string[] = [];
  const using = (terms: readonly string[]): Array<{ readonly who: string; readonly terms: string[] }> =>
    parts.flatMap((p) => {
      const hit = terms.filter((t) => usesTerm(p.text, t));
      return hit.length ? [{ who: p.who, terms: hit }] : [];
    });
  const listed = (hits: ReadonlyArray<{ readonly who: string; readonly terms: readonly string[] }>): string => hits.map((h) => `${h.who} (${h.terms.map((t) => `“${t}”`).join(', ')})`).join('; ');
  for (const old of list) {
    if (!old.supersededBy) continue;
    const now = byId.get(old.supersededBy);
    const replaced = `Decision [${old.id}] “${clip(decisionText(old))}” was replaced by [${old.supersededBy}]${now ? ` “${clip(decisionText(now))}”` : ''}`;
    // Its words, less the ones the new decision uses too.
    const terms = (old.terms ?? []).filter((t) => !(now?.terms ?? []).some((n) => n.toLowerCase() === t.toLowerCase()));
    if (terms.length) {
      const hits = using(terms);
      if (hits.length) out.push(`${replaced}, but these still use it: ${listed(hits)}. Bring them in line with the new decision.`);
    } else if (!was.get(old.id)?.supersededBy) {
      // Just superseded, with no words to look for: said once.
      out.push(`${replaced}. It gave no terms to look for: re-read every task against the new decision (plan_get) and fix the ones it touches.`);
    }
  }
  for (const d of list) {
    if (d.supersededBy || !d.retires?.length) continue;
    const hits = using(d.retires);
    if (hits.length) out.push(`Decision [${d.id}] “${clip(decisionText(d))}” retires ${d.retires.map((t) => `“${t}”`).join(', ')}, still used in: ${listed(hits)}.`);
  }
  return out;
}

const clip = (text: string, n = 90): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n).trimEnd()}…` : one;
};

/** Every warning for a plan as it is now (`previous`: as it was before this change). */
export function coherenceWarnings(body: PlanBody, previous?: PlanBody): string[] {
  return [...staleDecisions(body, previous), ...danglingRefs(body, previous), ...duplicates(body), ...sharedTouches(body), ...emptyMilestones(body)];
}

/** Tasks whose text still uses a superseded decision's terms (ids): for screens and tests. */
export function staleTasks(body: PlanBody, decision: Decided): string[] {
  if (!decision.supersededBy) return [];
  return allTasks(body)
    .filter((t) => (decision.terms ?? []).some((term) => usesTerm(taskText(t.task), term)))
    .map((t) => t.task.id);
}

/** Warnings as the tool's answer adds them (none: nothing). */
export function warningsText(warnings: readonly string[]): string {
  if (!warnings.length) return '';
  const shown = warnings.slice(0, MAX_WARNINGS);
  const more = warnings.length - shown.length;
  return [
    '',
    '',
    `Check ${warnings.length === 1 ? 'this' : 'these'} before you end your turn: fix ${warnings.length === 1 ? 'it' : 'them'} with plan_update, or tell the user why ${warnings.length === 1 ? 'it is' : 'they are'} fine:`,
    ...shown.map((w) => `- ${w}`),
    ...(more > 0 ? [`- …and ${more} more (plan_get lists them all).`] : []),
  ].join('\n');
}
