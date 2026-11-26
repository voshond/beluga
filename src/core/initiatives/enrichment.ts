import { z } from 'zod';
import { INITIATIVE_SLUG } from './model.js';
import type { Person, PersonDraft } from './people.js';

/** What enriching can fill on a directory entry. */
export const ENRICH_FIELDS = ['name', 'slack', 'slackId', 'jira', 'jiraId', 'github', 'email', 'title', 'avatar'] as const;
export type EnrichField = (typeof ENRICH_FIELDS)[number];

export const ENRICH_LABELS: Readonly<Record<EnrichField, string>> = {
  name: 'Full name',
  slack: 'Slack',
  slackId: 'Slack ID',
  jira: 'Jira',
  jiraId: 'Jira account',
  github: 'GitHub',
  email: 'Email',
  title: 'Title',
  avatar: 'Picture',
};

export const ENRICH_SOURCES = ['slack', 'jira', 'github', 'google'] as const;
export type EnrichSource = (typeof ENRICH_SOURCES)[number];

/** One value found for one person: where it came from and why the agent thinks it's them. */
export const EnrichProposalSchema = z.object({
  person: z.string().regex(INITIATIVE_SLUG),
  field: z.enum(ENRICH_FIELDS),
  value: z.string().trim().min(1).max(1000),
  source: z.enum(ENRICH_SOURCES),
  why: z.string().trim().max(300).catch(''),
});
export type EnrichProposal = z.infer<typeof EnrichProposalSchema>;

/** The directory's enrichment as the page shows it: running, what it found, or why it failed. */
export type Enrichment = {
  readonly running: boolean;
  readonly proposals: readonly EnrichProposal[];
  readonly error?: string;
  readonly at?: string;
};

export const NO_ENRICHMENT: Enrichment = { running: false, proposals: [] };

const squash = (value: string | undefined): string => (value ?? '').trim().toLowerCase().replace(/^@/, '');

const sane = (p: EnrichProposal): boolean => (p.field === 'avatar' ? /^https:\/\//i.test(p.value) : true);

/** What's worth showing: about someone in the directory, new for that field, one per person and field. */
export const freshProposals = (people: readonly Person[], proposals: readonly EnrichProposal[]): EnrichProposal[] => {
  const seen = new Set<string>();
  return proposals.filter((p) => {
    const person = people.find((x) => x.slug === p.person);
    const key = `${p.person}:${p.field}`;
    if (!person || !sane(p) || seen.has(key) || squash(person[p.field]) === squash(p.value)) return false;
    seen.add(key);
    return true;
  });
};

/** The agent's answer as proposals: each well-formed one, the rest left out. */
export const parseEnrichment = (raw: unknown): EnrichProposal[] => {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { proposals?: unknown }).proposals) ? (raw as { proposals: unknown[] }).proposals : [];
  return list.flatMap((entry) => {
    const parsed = EnrichProposalSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
};

/** A person with these proposals taken: what savePerson writes. */
export const withProposals = (person: Person, proposals: readonly EnrichProposal[]): PersonDraft =>
  proposals.reduce<PersonDraft>((draft, p) => (p.person === person.slug ? { ...draft, [p.field]: p.value } : draft), { ...person });

/** Proposals about one person, or one field of theirs. */
export const isAbout = (p: EnrichProposal, person: string, field?: EnrichField): boolean => p.person === person && (!field || p.field === field);
