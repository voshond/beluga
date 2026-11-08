import type { Totals } from '@beluga/shared/stats.js';
import type { IconName } from '../../components/Icon.js';
import { compact, formatCost } from './usage-model.js';

/**
 * Titles you earn from your stats (the Usage tab's card and recap): playful, but each with a plain
 * rule and the number that earned it. Your title is the one you're furthest past the bar for.
 */
export interface Title {
  readonly id: string;
  readonly name: string;
  readonly icon: IconName;
  /** A pastel the card is drawn in (CSS colour). */
  readonly color: string;
  /** Why: the number behind it, in a few words. */
  readonly why: string;
  /** How far past the bar (1: just made it). */
  readonly score: number;
}

/** What the titles look at: all-time totals, when prompts were sent, streaks, how many agents. */
export interface TitleInput {
  readonly all: Totals;
  readonly hours: readonly number[];
  readonly longestStreak: number;
  readonly agents: number;
}

const HOUR = 3_600_000;
const sumHours = (hours: readonly number[], pick: (day: number, hour: number) => boolean): number => hours.reduce((n, v, i) => n + (pick(Math.floor(i / 24), i % 24) ? v : 0), 0);

interface Rule {
  readonly id: string;
  readonly name: string;
  readonly icon: IconName;
  readonly color: string;
  /** How far past the bar (≥ 1 earns it), and why. */
  readonly test: (x: TitleInput) => { score: number; why: string };
}

const share = (part: number, whole: number): number => (whole ? part / whole : 0);
const pct = (f: number): string => `${Math.round(f * 100)}%`;

const RULES: readonly Rule[] = [
  { id: 'code-god', name: 'Code God', icon: 'bolt', color: '#8c7bf0', test: (x) => ({ score: (x.all.linesAdded + x.all.linesRemoved) / 10_000, why: `${compact(x.all.linesAdded + x.all.linesRemoved)} lines shipped in merged PRs` }) },
  { id: 'merge-machine', name: 'Merge Machine', icon: 'merge', color: '#b294f0', test: (x) => ({ score: x.all.prsMerged / 25, why: `${x.all.prsMerged} pull requests merged` }) },
  { id: 'talkative', name: 'Talkative', icon: 'send', color: '#6ea8f5', test: (x) => ({ score: x.all.prompts / 1000, why: `${x.all.prompts.toLocaleString()} prompts sent` }) },
  { id: 'novelist', name: 'The Novelist', icon: 'book', color: '#5fb3d9', test: (x) => ({ score: share(x.all.chars, x.all.prompts) / 450, why: `${Math.round(share(x.all.chars, x.all.prompts))} characters a prompt` }) },
  { id: 'paste-wizard', name: 'Copy-Paste Wizard', icon: 'clip', color: '#f2b84b', test: (x) => ({ score: x.all.pasted / 250_000, why: `${compact(x.all.pasted)} characters pasted` }) },
  { id: 'voice', name: 'Voice Commander', icon: 'mic', color: '#ef8fb4', test: (x) => ({ score: x.all.dictationMs / HOUR, why: `${Math.round(x.all.dictationMs / 60_000)} minutes dictated` }) },
  {
    id: 'night-owl',
    name: 'Night Owl',
    icon: 'eye',
    color: '#7d86e8',
    test: (x) => {
      const f = share(
        sumHours(x.hours, (_, h) => h >= 22 || h < 4),
        sumHours(x.hours, () => true),
      );
      return { score: f / 0.2, why: `${pct(f)} of prompts between 10 PM and 4 AM` };
    },
  },
  {
    id: 'early-bird',
    name: 'Early Bird',
    icon: 'bulb',
    color: '#f5c35b',
    test: (x) => {
      const f = share(
        sumHours(x.hours, (_, h) => h >= 5 && h < 9),
        sumHours(x.hours, () => true),
      );
      return { score: f / 0.2, why: `${pct(f)} of prompts before 9 AM` };
    },
  },
  {
    id: 'weekend',
    name: 'Weekend Warrior',
    icon: 'calendar',
    color: '#5cc49a',
    test: (x) => {
      const f = share(
        sumHours(x.hours, (d) => d === 0 || d === 6),
        sumHours(x.hours, () => true),
      );
      return { score: f / 0.25, why: `${pct(f)} of prompts on weekends` };
    },
  },
  { id: 'marathon', name: 'Marathoner', icon: 'clock', color: '#4fb8a8', test: (x) => ({ score: x.all.agentMs / (100 * HOUR), why: `${Math.round(x.all.agentMs / HOUR).toLocaleString()} hours of agent time` }) },
  { id: 'branches', name: 'Branch Collector', icon: 'branch', color: '#6cc187', test: (x) => ({ score: x.all.worktrees / 50, why: `${x.all.worktrees} worktrees made` }) },
  { id: 'tidy', name: 'Neat Freak', icon: 'archive', color: '#8fcfc4', test: (x) => ({ score: x.all.worktrees >= 10 ? share(x.all.archived, x.all.worktrees) / 0.6 : 0, why: `${pct(share(x.all.archived, x.all.worktrees))} of worktrees put away` }) },
  { id: 'streak', name: 'Streak Keeper', icon: 'flame', color: '#f09a6b', test: (x) => ({ score: x.longestStreak / 14, why: `${x.longestStreak} days in a row` }) },
  { id: 'polyglot', name: 'Agent Whisperer', icon: 'bot', color: '#a0a7f2', test: (x) => ({ score: (x.agents - 1) / 2, why: `${x.agents} different agents` }) },
  { id: 'tycoon', name: 'Token Tycoon', icon: 'coin', color: '#e7a95b', test: (x) => ({ score: x.all.tokens / 50_000_000, why: `${compact(x.all.tokens)} tokens, ${formatCost(x.all.cost)}` }) },
];

/** Everyone starts here: nothing earned yet. */
export const ROOKIE: Title = { id: 'rookie', name: 'Fresh Start', icon: 'sparkles', color: '#9fb7f5', why: 'Titles come as your stats grow', score: 0 };

/** The titles earned, best first (your title first); none: the starting one. */
export function titlesOf(x: TitleInput): Title[] {
  const earned = RULES.map((r) => ({ id: r.id, name: r.name, icon: r.icon, color: r.color, ...r.test(x) }))
    .filter((t) => Number.isFinite(t.score) && t.score >= 1)
    .sort((a, b) => b.score - a.score);
  return earned.length ? earned : [ROOKIE];
}
