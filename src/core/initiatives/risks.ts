import { z } from 'zod';
import { type Ticket, type TicketCategory, SuggestionProofSchema } from './model.js';

export const RISK_SEVERITIES = ['high', 'medium', 'low'] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export const RISK_STATES = ['open', 'watching', 'closed'] as const;
export type RiskState = (typeof RISK_STATES)[number];

const lowered = (value: unknown): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

const maybe = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value?.trim() || undefined);

/** What the owner wrote or changed on the page; an empty string is a field they cleared. It wins over the agent's. */
export const RiskOwnedSchema = z.object({
  title: z.string().max(200).optional(),
  why: z.string().max(2000).optional(),
  severity: z.enum(RISK_SEVERITIES).optional(),
  owner: z.string().max(120).optional(),
  mitigation: z.string().max(2000).optional(),
  state: z.enum(RISK_STATES).optional(),
  at: z.string().max(40).optional(),
});
export type RiskOwned = z.infer<typeof RiskOwnedSchema>;

/** One thing that could sink the initiative (risks.json); the agent writes it, the owner's edits sit in `owned`. */
export const RiskSchema = z.object({
  id: z.number().int().min(1),
  title: z.string().trim().min(1).max(200),
  why: maybe(2000),
  severity: z.preprocess(lowered, z.enum(RISK_SEVERITIES)).catch('medium'),
  owner: maybe(120),
  mitigation: maybe(2000),
  state: z.preprocess(lowered, z.enum(RISK_STATES)).catch('open'),
  sources: z.array(SuggestionProofSchema).max(20).default([]),
  blocker: maybe(40),
  createdAt: maybe(40),
  updatedAt: maybe(40),
  closedAt: maybe(40),
  owned: RiskOwnedSchema.optional(),
});
export type Risk = z.infer<typeof RiskSchema>;

export const RisksSchema = z.array(RiskSchema).max(200);

/** What the page sends: a new risk without an id, or a change to one. */
export const RiskDraftSchema = z.object({
  id: z.number().int().min(1).optional(),
  title: z.string().trim().min(1).max(200),
  why: z.string().max(2000).optional(),
  severity: z.enum(RISK_SEVERITIES),
  owner: z.string().max(120).optional(),
  mitigation: z.string().max(2000).optional(),
  state: z.enum(RISK_STATES),
});
export type RiskDraft = z.infer<typeof RiskDraftSchema>;

const ownedText = (owned: string | undefined, agent: string | undefined): string | undefined => (owned === undefined ? agent : owned.trim() || undefined);

/** The risk as it shows: the owner's values over the agent's. */
export const riskOf = (risk: Risk): Risk => {
  const owned = risk.owned;
  if (!owned) return risk;
  return {
    ...risk,
    title: owned.title?.trim() || risk.title,
    why: ownedText(owned.why, risk.why),
    severity: owned.severity ?? risk.severity,
    owner: ownedText(owned.owner, risk.owner),
    mitigation: ownedText(owned.mitigation, risk.mitigation),
    state: owned.state ?? risk.state,
  };
};

const SEVERITY_RANK: Readonly<Record<RiskSeverity, number>> = { high: 0, medium: 1, low: 2 };

const STATE_RANK: Readonly<Record<RiskState, number>> = { open: 0, watching: 1, closed: 2 };

/** Open and watched risks, the most severe first. */
export const openRisks = (risks: readonly Risk[]): Risk[] =>
  risks
    .map(riskOf)
    .filter((r) => r.state !== 'closed')
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || STATE_RANK[a.state] - STATE_RANK[b.state] || a.id - b.id);

/** Closed risks, the latest closed first. */
export const closedRisks = (risks: readonly Risk[]): Risk[] =>
  risks
    .map(riskOf)
    .filter((r) => r.state === 'closed')
    .sort((a, b) => (b.closedAt ?? b.owned?.at ?? '').localeCompare(a.closedAt ?? a.owned?.at ?? '') || b.id - a.id);

export const nextRiskId = (risks: readonly Pick<Risk, 'id'>[]): number => risks.reduce((n, r) => Math.max(n, r.id), 0) + 1;

/** A risk with the page's draft as the owner's edit on top: a new one is the owner's from the start. */
export const ownerRisk = (risks: readonly Risk[], draft: RiskDraft, at: string): Risk => {
  const owned: RiskOwned = {
    title: draft.title.trim(),
    why: draft.why?.trim() ?? '',
    severity: draft.severity,
    owner: draft.owner?.trim() ?? '',
    mitigation: draft.mitigation?.trim() ?? '',
    state: draft.state,
    at,
  };
  const was = draft.id === undefined ? undefined : risks.find((r) => r.id === draft.id);
  if (draft.id !== undefined && !was) throw new Error('That risk is gone');
  const closedAt = draft.state === 'closed' ? (was && riskOf(was).state === 'closed' ? was.closedAt ?? at : at) : undefined;
  const base: Risk = was ?? { id: nextRiskId(risks), title: owned.title ?? draft.title, why: undefined, severity: draft.severity, owner: undefined, mitigation: undefined, state: draft.state, sources: [], blocker: undefined, createdAt: at, updatedAt: undefined, closedAt: undefined };
  return { ...base, updatedAt: at, closedAt, owned };
};

/** What the timeline says the owner did to a risk. */
export const ownerRiskLine = (was: Risk | undefined, risk: Risk): string => {
  const now = riskOf(risk);
  const verb = !was ? 'added' : riskOf(was).state !== 'closed' && now.state === 'closed' ? 'closed' : riskOf(was).state === 'closed' && now.state !== 'closed' ? 'reopened' : 'changed';
  return `${verb} risk ${risk.id} “${now.title}” on the page`;
};

/** Puts the owner's edits back where a turn dropped or changed them: a risk it removed comes back whole. */
export const withOwnerEdits = (risks: readonly Risk[], kept: readonly Risk[]): { readonly risks: Risk[]; readonly changed: boolean } => {
  let changed = false;
  const out = risks.map((risk) => {
    const mine = kept.find((k) => k.id === risk.id);
    if (!mine?.owned || JSON.stringify(risk.owned) === JSON.stringify(mine.owned)) return risk;
    changed = true;
    return { ...risk, owned: mine.owned };
  });
  const gone = kept.filter((k) => k.owned && !risks.some((r) => r.id === k.id));
  return { risks: [...out, ...gone], changed: changed || gone.length > 0 };
};

export type Blocker = {
  readonly key: string;
  readonly summary?: string;
  readonly status?: string;
  readonly statusCategory: TicketCategory;
  readonly url?: string;
  /** Not one of the tickets read under the initiative's epics. */
  readonly outside: boolean;
};

/** What blocks a ticket: its own "is blocked by" links and the read tickets that say they block it, with the freshest status known. */
export const blockersOf = (ticket: Pick<Ticket, 'key' | 'links'>, tickets: readonly Ticket[]): Blocker[] => {
  const direct = (ticket.links ?? []).filter((l) => l.type === 'blockedBy');
  const inverse = tickets.filter((t) => t.key !== ticket.key && (t.links ?? []).some((l) => l.type === 'blocks' && l.key === ticket.key)).map((t) => t.key);
  const keys = [...new Set([...direct.map((l) => l.key), ...inverse])].filter((key) => key !== ticket.key);
  return keys.map((key): Blocker => {
    const read = tickets.find((t) => t.key === key);
    if (read) return { key, summary: read.summary || undefined, status: read.status || undefined, statusCategory: read.statusCategory, ...(read.url ? { url: read.url } : {}), outside: false };
    const link = direct.find((l) => l.key === key);
    return { key, ...(link?.summary ? { summary: link.summary } : {}), ...(link?.status ? { status: link.status } : {}), statusCategory: link?.statusCategory ?? 'todo', ...(link?.url ? { url: link.url } : {}), outside: true };
  });
};

export const openBlockersOf = (ticket: Pick<Ticket, 'key' | 'links'>, tickets: readonly Ticket[]): Blocker[] => blockersOf(ticket, tickets).filter((b) => b.statusCategory !== 'done');

export type OutsideBlocker = {
  readonly blocker: Blocker;
  readonly blocks: readonly string[];
};

/** Open blockers outside the epics that hold up an open ticket, each with the tickets it holds up. */
export const outsideBlockers = (tickets: readonly Ticket[]): OutsideBlocker[] =>
  tickets
    .filter((t) => t.statusCategory !== 'done')
    .flatMap((t) => openBlockersOf(t, tickets).filter((b) => b.outside).map((blocker) => ({ blocker, blocked: t.key })))
    .reduce<OutsideBlocker[]>((all, { blocker, blocked }) => {
      const at = all.findIndex((x) => x.blocker.key === blocker.key);
      if (at === -1) return [...all, { blocker, blocks: [blocked] }];
      return all.map((x, n) => (n === at ? { ...x, blocks: [...x.blocks, blocked] } : x));
    }, []);

const names = (risk: Risk, key: string): boolean => risk.blocker?.toUpperCase() === key.toUpperCase() || new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(riskOf(risk).title);

const blockerWhy = ({ blocker, blocks }: OutsideBlocker): string => {
  const what = blocker.summary ? `${blocker.key} (${blocker.summary})` : blocker.key;
  return `${blocks.join(', ')} ${blocks.length === 1 ? 'is' : 'are'} blocked by ${what}, ${blocker.status ?? 'not done'}, which is not under the initiative’s epics.`;
};

/** A risk for each open outside blocker no risk names yet (any state: one the owner closed stays closed). */
export const blockerRisks = (tickets: readonly Ticket[], risks: readonly Risk[], at: string): Risk[] =>
  outsideBlockers(tickets)
    .filter((x) => !risks.some((r) => names(r, x.blocker.key)))
    .map((x, n): Risk => ({
      id: nextRiskId(risks) + n,
      title: `Blocked by ${x.blocker.key}, outside the initiative`,
      why: blockerWhy(x),
      severity: 'medium',
      owner: undefined,
      mitigation: undefined,
      state: 'open',
      sources: [{ label: x.blocker.summary ? `${x.blocker.key}: ${x.blocker.summary}`.slice(0, 200) : x.blocker.key, ...(x.blocker.url ? { url: x.blocker.url } : {}) }],
      blocker: x.blocker.key,
      createdAt: at,
      updatedAt: undefined,
      closedAt: undefined,
    }));

export const LINKS_HOW =
  'Read every ticket’s and sub-task’s issue links (jira_get_issue returns them, or jira_search with the "issuelinks" field) and keep the "Blocks" ones on the ticket as "links": [{"type" ("blocks" | "blockedBy"), "key", "summary", "status", "statusCategory", "url"}], whether or not the other ticket is under the epics; other link types stay out. For a linked ticket outside the epics read its status too, and when it is a story that stays To Do while its sub-tasks move, judge it by its sub-tasks: "inProgress" once any of them moved, "done" only when it and they are.';

export const RISKS_MEMORY =
  'risks.json: what could sink it, a short list the page shows by severity, an array of {"id" (a number, never reused), "title", "why", "severity" ("high" | "medium" | "low"), "owner" (a person’s name), "mitigation", "state" ("open" | "watching" | "closed"), "sources" ([{"label", "url"}]), "blocker" (the key of an outside ticket it is about), "createdAt", "updatedAt", "closedAt"}. "owned" on a risk is the owner’s own edit from the page, which Beluga writes and puts back: never change or drop it, and leave the fields it holds as they are; when you think such a risk should change, say so in a suggestion.';

export const RISKS_HOW =
  'Then keep risks.json current: add a risk for what threatens the goal or the date (an open blocker, an epic that stalled, work nobody owns, a decision nobody made), update one whose picture changed, and close one that no longer holds ("state": "closed", "closedAt", and its "why" saying what changed). Every open ticket blocked by a ticket outside the epics that is not done gets a risk with "blocker" set to that key and the key in its title; close it once the blocker is done. Keep it to the few that matter: three severities, no scores. For each risk you add, change or close, add a timeline.md line, "- 2026-11-26 [risk]: raised risk 4 “…”: why" (or updated, or closed). When a risk needs the owner’s call, raise it as a decision suggestion too.';
