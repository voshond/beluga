import { type InitiativeView, type OutboxDraft, type Suggestion, linkOf, targetWords, ticketUrlOf } from './model.js';

export type LogState = 'open' | 'approved' | 'decided' | 'dismissed';

export const LOG_STATE_LABEL: Readonly<Record<LogState, string>> = { open: 'Open', approved: 'Approved', decided: 'Decided', dismissed: 'Dismissed' };

export type LogProof = {
  readonly label: string;
  readonly url?: string;
  readonly from: 'chat' | 'outbox';
};

export const logStateOf = (suggestion: Pick<Suggestion, 'state' | 'answer'>): LogState => {
  if (suggestion.state === 'approved' && suggestion.answer) return 'decided';
  return suggestion.state;
};

export const suggestionHistory = (item: Pick<InitiativeView, 'suggestions'>): Suggestion[] =>
  item.suggestions.filter((s) => s.state !== 'open').sort((a, b) => (b.resolvedAt ?? '').localeCompare(a.resolvedAt ?? ''));

const sentProof = (draft: OutboxDraft): LogProof => ({
  label: `${draft.to.kind === 'slack' ? 'Slack message' : 'Jira comment'} sent to ${targetWords(draft.to)}`,
  from: 'outbox',
});

export const proofOf = (suggestion: Pick<Suggestion, 'id' | 'proof'>, outbox: readonly OutboxDraft[]): LogProof[] => [
  ...(suggestion.proof ?? []).map((p): LogProof => ({ ...p, from: 'chat' })),
  ...outbox.filter((d) => d.suggestion === suggestion.id && d.state === 'sent').map(sentProof),
];

export type LogSource = {
  readonly label: string;
  readonly url?: string;
};

export type SourceContext = Pick<InitiativeView, 'epics' | 'tickets' | 'docs' | 'slack' | 'outbox'>;

const TICKET_MENTION = /\b([A-Z][A-Z0-9_]+)-(\d+)((?:\/\d+)*)\b/g;
const URL_MENTION = /https?:\/\/[^\s<>()"'`]+/g;

const projectOf = (key: string): string => key.replace(/-\d+$/, '');

const jiraProjects = (item: SourceContext): Set<string> =>
  new Set([...item.epics, ...(item.tickets?.tickets ?? []).map((t) => t.key), ...item.outbox.flatMap((d) => (d.to.kind === 'jira' ? [d.to.issue] : []))].map(projectOf));

export const ticketKeysIn = (text: string, projects: ReadonlySet<string>): string[] =>
  [...text.matchAll(TICKET_MENTION)]
    .filter(([, project]) => projects.has(project!))
    .flatMap(([, project, first, more]) => [first!, ...more!.split('/').filter(Boolean)].map((n) => `${project}-${n}`));

const urlsIn = (text: string): string[] => [...text.matchAll(URL_MENTION)].map(([url]) => url.replace(/[.,;:!?]+$/, ''));

const mentions = (text: string, label: string | undefined): boolean => Boolean(label && label.length >= 4 && text.toLowerCase().includes(label.toLowerCase()));

const ticketSource = (key: string, item: SourceContext): LogSource => {
  const summary = item.tickets?.tickets.find((t) => t.key === key)?.summary ?? item.tickets?.epics.find((e) => e.key === key)?.title;
  return { label: summary ? `${key} · ${summary}` : key, url: ticketUrlOf(key, item.tickets) };
};

/** What a suggestion is about: the sources the agent named, then the tickets, links, docs and channels its words mention. */
export const sourcesOf = (suggestion: Pick<Suggestion, 'text' | 'why' | 'outcome' | 'sources'>, item: SourceContext): LogSource[] => {
  const text = [suggestion.text, suggestion.why, suggestion.outcome].filter(Boolean).join('\n');
  const named = item.docs.map((d) => ({ label: d.label ?? d.ref, url: linkOf(d.ref) }));
  const channels = item.slack.map((c) => ({ label: c.label ?? c.ref, url: linkOf(c.ref) }));
  const all: LogSource[] = [
    ...(suggestion.sources ?? []).map((p) => ({ label: p.label, url: p.url ? linkOf(p.url) : undefined })),
    ...ticketKeysIn(text, jiraProjects(item)).map((key) => ticketSource(key, item)),
    ...urlsIn(text).map((url) => [...named, ...channels].find((n) => n.url === url) ?? { label: url, url }),
    ...[...named, ...channels].filter((n) => n.url && mentions(text, n.label)),
  ];
  const seen = new Set<string>();
  return all.filter((source) => {
    const id = source.url ?? source.label;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

export const dayOfIso = (iso: string | undefined): string => (iso ? iso.slice(0, 10) : '');

const linkLine = (link: LogSource): string => (link.url ? `- [${link.label}](${link.url})` : `- ${link.label}`);

export const recordMarkdown = (suggestion: Suggestion, item: SourceContext): string => {
  const state = logStateOf(suggestion);
  const proof = proofOf(suggestion, item.outbox);
  const sources = sourcesOf(suggestion, item);
  const lines = [
    `## ${suggestion.text}`,
    '',
    `${LOG_STATE_LABEL[state]}${suggestion.resolvedAt ? ` on ${dayOfIso(suggestion.resolvedAt)}` : ''}`,
    ...(suggestion.why ? ['', '### Context', '', suggestion.why] : []),
    ...(sources.length ? ['', '### Sources', '', ...sources.map(linkLine)] : []),
    ...(suggestion.answer ? ['', '### Decision', '', suggestion.answer] : []),
    ...(suggestion.outcome ? ['', '### Outcome', '', suggestion.outcome] : []),
    ...(proof.length ? ['', '### Proof', '', ...proof.map(linkLine)] : []),
  ];
  return `${lines.join('\n')}\n`;
};
