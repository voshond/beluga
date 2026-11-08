import type { AppState } from '@beluga/core/store.js';
import { type StatsSnapshot, streaks, totalsBy, totalsOf } from '@beluga/shared/stats.js';
import type { IconName } from '../../components/Icon.js';
import { duration, favouriteHour, groupOf } from './stats-model.js';
import { type Title, titlesOf } from './titles.js';
import { compact } from './usage-model.js';

/**
 * Your recap, Wrapped-style (Recap.tsx): a slide per thing worth a big number, in the words you'd
 * say it. A slide with nothing behind it (no pull requests, never dictated, one agent) is left out,
 * so the story always makes sense.
 */
export interface Slide {
  readonly id: string;
  /** The slide's colour (CSS). */
  readonly color: string;
  readonly icon: IconName;
  readonly lead: string;
  /** The big figure: counted up to on screen. */
  readonly value?: number;
  readonly format?: (n: number) => string;
  /** Instead of a number: a name (a project, a title). */
  readonly big?: string;
  readonly after?: string;
  readonly note?: string;
  /** Bars under it: each one's share. */
  readonly bars?: ReadonlyArray<{ readonly name: string; readonly color: string; readonly share: number; readonly value: string }>;
  /** The last slide: your title. */
  readonly title?: Title;
}

const HOUR = 3_600_000;
const NOVEL = 450_000;
const WORDS_PER_MIN = 130;
const hoursOf = (ms: number): string => (ms >= HOUR ? `${Math.round(ms / HOUR).toLocaleString()} hours` : duration(ms));

export function recapSlides(stats: StatsSnapshot, state: Pick<AppState, 'projects'>, name: string, now: number, worn?: Title): Slide[] {
  const all = totalsOf(stats, '');
  const { longest, current } = streaks(stats, now);
  const byProject = [...totalsBy(stats, 'project', '').entries()].filter(([, t]) => t.agentMs > 0).sort((a, b) => b[1].agentMs - a[1].agentMs);
  const byAgent = [...totalsBy(stats, 'agent', '').entries()].filter(([k, t]) => k && t.prompts + t.agentMs > 0).sort((a, b) => b[1].prompts - a[1].prompts);
  const hour = favouriteHour(stats.hours);
  const titles = titlesOf({ all, hours: stats.hours, longestStreak: longest, agents: byAgent.length });
  const since = stats.since ? new Date(stats.since).toLocaleDateString([], { month: 'long', year: 'numeric' }) : 'today';
  const first = name.split(' ')[0] || name;
  const slides: Slide[] = [{ id: 'hello', color: 'var(--series-1)', icon: 'sparkles', lead: `${first}, this is you and your agents`, big: 'Your Beluga, so far', note: `Since ${since}. Press → or click to go on.` }];
  if (all.agentMs > 0) slides.push({ id: 'time', color: 'var(--worktree)', icon: 'clock', lead: 'Your agents worked for', value: all.agentMs, format: hoursOf, after: `over ${all.runs.toLocaleString()} runs`, note: all.agentMs >= 8 * HOUR ? `That’s about ${Math.round(all.agentMs / (8 * HOUR))} workdays, while you did something else.` : 'And they’re only getting started.' });
  if (all.prompts > 0)
    slides.push({
      id: 'prompts',
      color: 'var(--series-1)',
      icon: 'send',
      lead: 'You sent',
      value: all.prompts,
      format: (n) => Math.round(n).toLocaleString(),
      after: all.prompts === 1 ? 'prompt' : 'prompts',
      note: `${compact(all.chars)} characters, about ${Math.round(all.chars / all.prompts)} a prompt.${hour ? ` Mostly on ${hour.day} around ${hour.time}.` : ''}`,
    });
  if (all.pasted > 0) slides.push({ id: 'pasted', color: 'var(--series-4)', icon: 'clip', lead: 'You pasted', value: all.pasted, format: (n) => compact(n), after: 'characters', note: all.pasted >= NOVEL / 2 ? `That’s ${(all.pasted / NOVEL).toFixed(1)} novels’ worth. Ctrl-C, Ctrl-V, legend.` : `About ${Math.max(1, Math.round(all.pasted / 1800))} pages of text.` });
  if (all.dictationMs > 0) slides.push({ id: 'voice', color: 'var(--series-5)', icon: 'mic', lead: 'You talked to your agents for', value: all.dictationMs, format: (n) => duration(n), note: `Around ${compact(Math.round((all.dictationMs / 60_000) * WORDS_PER_MIN))} words, no typing.` });
  if (byProject.length) {
    const top = byProject[0]!;
    const sum = byProject.reduce((n, [, t]) => n + t.agentMs, 0);
    slides.push({
      id: 'project',
      color: 'var(--series-3)',
      icon: 'folder',
      lead: 'Your favourite place to be',
      big: groupOf(top[0], 'project', state.projects).name,
      note: `${Math.round((top[1].agentMs / sum) * 100)}% of your agents’ time went here.`,
      bars: byProject.slice(0, 4).map(([k, t]) => ({ name: groupOf(k, 'project', state.projects).name, color: groupOf(k, 'project', state.projects).color, share: t.agentMs / sum, value: hoursOf(t.agentMs) })),
    });
  }
  if (byAgent.length > 1) {
    const sum = byAgent.reduce((n, [, t]) => n + t.prompts, 0);
    slides.push({
      id: 'agents',
      color: 'var(--claude)',
      icon: 'bot',
      lead: 'Your go-to agent',
      big: groupOf(byAgent[0]![0], 'agent', state.projects).name,
      note: `But you also worked with ${byAgent.length - 1} ${byAgent.length === 2 ? 'other' : 'others'}.`,
      bars: byAgent.slice(0, 4).map(([k, t]) => ({ name: groupOf(k, 'agent', state.projects).name, color: groupOf(k, 'agent', state.projects).color, share: t.prompts / sum, value: `${t.prompts.toLocaleString()} prompts` })),
    });
  }
  if (all.prsMerged > 0) slides.push({ id: 'shipped', color: 'var(--merged)', icon: 'merge', lead: 'You shipped', value: all.prsMerged, format: (n) => Math.round(n).toLocaleString(), after: all.prsMerged === 1 ? 'pull request' : 'pull requests', note: `+${compact(all.linesAdded)} and −${compact(all.linesRemoved)} lines, merged.` });
  else if (all.worktrees > 0) slides.push({ id: 'worktrees', color: 'var(--series-3)', icon: 'branch', lead: 'You started', value: all.worktrees, format: (n) => Math.round(n).toLocaleString(), after: all.worktrees === 1 ? 'worktree' : 'worktrees', note: `And put ${all.archived.toLocaleString()} away when they were done.` });
  if (longest > 1) slides.push({ id: 'streak', color: 'var(--series-2)', icon: 'flame', lead: 'Your longest streak', value: longest, format: (n) => Math.round(n).toLocaleString(), after: 'days in a row', note: current > 1 ? `You’re on day ${current} of a new one right now.` : 'Ready for the next one?' });
  // The title you wear on your pass (else the one you earned most).
  const t = worn ?? titles[0]!;
  slides.push({ id: 'title', color: t.color, icon: t.icon, lead: 'All of which makes you', title: t, note: t.id === 'rookie' ? t.why : `Because: ${t.why}.` });
  return slides;
}
