import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PeopleEnrichRequest } from '../../agent/people-enricher.js';
import { type EnrichField, type EnrichProposal, type Enrichment, NO_ENRICHMENT, freshProposals, isAbout, parseEnrichment, withProposals } from './enrichment.js';
import { writeText } from './files.js';
import type { Person, PersonDraft } from './people.js';

export type EnricherDeps = {
  readonly dir: string | null;
  readonly people: () => readonly Person[];
  /** Jira project keys the initiatives' epics are in. */
  readonly projects: () => readonly string[];
  readonly enrich?: (req: PeopleEnrichRequest) => Promise<EnrichProposal[] | undefined>;
  readonly save: (draft: PersonDraft) => Promise<unknown>;
  readonly publish: (enrichment: Enrichment) => void;
  readonly now: () => number;
};

/**
 * Enrich People: your agent looks the directory up in Slack, Jira, the Google directory and GitHub,
 * and what it found waits here (`<dir>/enrichment.json`) until the owner takes or dismisses each value.
 */
export class PeopleEnricher {
  private state: Enrichment;

  constructor(private readonly deps: EnricherDeps) {
    this.state = { running: false, proposals: this.read() };
  }

  private file(): string | undefined {
    return this.deps.dir ? path.join(this.deps.dir, 'enrichment.json') : undefined;
  }

  private read(): EnrichProposal[] {
    const file = this.file();
    if (!file) return [];
    try {
      return parseEnrichment(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  }

  /** What the page shows: only values that are still new for someone still in the directory. */
  get view(): Enrichment {
    return { ...this.state, proposals: freshProposals(this.deps.people(), this.state.proposals) };
  }

  private set(next: Enrichment): void {
    this.state = next;
    const file = this.file();
    if (file) writeText(file, `${JSON.stringify(next.proposals, null, 2)}\n`);
    this.deps.publish(this.view);
  }

  /** Looks up everyone, or only these people; what it finds replaces what was waiting for them. */
  start(only?: readonly string[]): void {
    if (!this.deps.enrich) throw new Error('Enriching people needs an agent');
    if (this.state.running) throw new Error('Already looking them up');
    const people = this.deps.people().filter((p) => !only?.length || only.includes(p.slug));
    if (!people.length) throw new Error('Nobody to look up');
    const { error: _was, ...rest } = this.state;
    this.set({ ...rest, running: true });
    void this.run(people);
  }

  private async run(people: readonly Person[]): Promise<void> {
    const enrich = this.deps.enrich!;
    const found = await enrich({ people, projects: this.deps.projects() }).catch(() => undefined);
    const looked = new Set(people.map((p) => p.slug));
    const at = new Date(this.deps.now()).toISOString();
    if (!found) return this.set({ ...this.state, running: false, error: 'Your agent couldn’t look them up: try again', at });
    this.set({ running: false, proposals: [...this.state.proposals.filter((p) => !looked.has(p.person)), ...found], at });
  }

  /** Takes what was found for a person (or one field of theirs) into their entry. */
  async keep(person: string, field?: EnrichField): Promise<void> {
    const entry = this.deps.people().find((p) => p.slug === person);
    if (!entry) throw new Error('They are not in the directory');
    const taking = this.view.proposals.filter((p) => isAbout(p, person, field));
    if (!taking.length) return;
    await this.deps.save(withProposals(entry, taking));
    this.set({ ...this.state, proposals: this.state.proposals.filter((p) => !isAbout(p, person, field)) });
  }

  /** Dismisses what was found for a person (or one field of theirs). */
  drop(person: string, field?: EnrichField): void {
    this.set({ ...this.state, proposals: this.state.proposals.filter((p) => !isAbout(p, person, field)) });
  }

  /** The directory changed: values it now has drop out of the view. */
  refresh(): void {
    this.deps.publish(this.view);
  }
}
