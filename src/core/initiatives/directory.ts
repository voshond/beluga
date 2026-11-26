import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { writeText } from './files.js';
import type { z } from 'zod';
import { INITIATIVE_SLUG, type PersonProposalSchema, uniqueSlug } from './model.js';
import { DirectoryPersonSchema, PEOPLE_DIR, type Person, type PersonDraft, PersonDraftSchema, personOf } from './people.js';

const README = `# People

One file per person, shared by every initiative: \`<slug>.json\` with \`name\`, \`cares\` (what they care about), \`slack\`, \`jira\` and \`notes\`. An initiative's \`initiative.json\` names them in \`people\` as \`{ "person": "<slug>", "role": "…" }\`.
`;

const folderOf = (root: string): string => path.join(root, PEOPLE_DIR);

const fileOf = (root: string, slug: string): string => {
  if (!INITIATIVE_SLUG.test(slug)) throw new Error(`“${slug}” is not a person’s file name`);
  return path.join(folderOf(root), `${slug}.json`);
};

/** Everyone in the directory, by name; a file that doesn't parse is left out. */
export const readDirectory = (root: string): Person[] => {
  let names: string[] = [];
  try {
    names = readdirSync(folderOf(root)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((n): Person | undefined => {
      const slug = n.slice(0, -'.json'.length);
      if (!INITIATIVE_SLUG.test(slug)) return undefined;
      try {
        const parsed = DirectoryPersonSchema.safeParse(JSON.parse(readFileSync(path.join(folderOf(root), n), 'utf8')));
        return parsed.success ? { slug, ...parsed.data } : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((p): p is Person => Boolean(p))
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
};

/** Writes one entry (a new slug from the name when it has none) and the folder's README: → its slug. */
export const writePerson = (root: string, draft: PersonDraft): string => {
  const { slug: given, ...fields } = PersonDraftSchema.parse(draft);
  const taken = new Set(readDirectory(root).map((p) => p.slug));
  const slug = given ?? uniqueSlug(fields.name, taken);
  if (!existsSync(path.join(folderOf(root), 'README.md'))) writeText(path.join(folderOf(root), 'README.md'), README);
  writeText(fileOf(root, slug), `${JSON.stringify(fields, null, 2)}\n`);
  return slug;
};

export const removePersonFile = (root: string, slug: string): void => rmSync(fileOf(root, slug), { force: true });

/** A proposal folded into the directory: an entry it names (or one with its name) keeps what it has and gains what was empty. → its slug. */
export const keepProposal = (root: string, proposal: z.input<typeof PersonProposalSchema>): string => {
  const people = readDirectory(root);
  const known = (proposal.person ? people.find((p) => p.slug === proposal.person) : undefined) ?? personOf(people, proposal.name);
  const fill = (was: string | undefined, next: string | null | undefined): string => (was?.trim() ? was : (next?.trim() ?? ''));
  return writePerson(root, {
    ...(known ? { slug: known.slug } : {}),
    name: known?.name ?? proposal.name,
    cares: fill(known?.cares, proposal.cares),
    slack: fill(known?.slack, proposal.slack),
    jira: fill(known?.jira, proposal.jira),
    notes: fill(known?.notes, proposal.notes),
  });
};
