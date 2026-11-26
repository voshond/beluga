import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enrichPeople, enrichPrompt, enrichVerdict, isEnrichServer } from '../src/agent/people-enricher.js';
import { PeopleEnricher } from '../src/core/initiatives/enricher.js';
import { type EnrichProposal, type Enrichment, freshProposals, parseEnrichment, withProposals } from '../src/core/initiatives/enrichment.js';
import { PeopleAvatars } from '../src/core/initiatives/people-avatars.js';
import { DirectoryPersonSchema, type Person, type PersonDraft, isPerson } from '../src/core/initiatives/people.js';

const julia: Person = { slug: 'julia', name: 'Julia', cares: '', slack: '', jira: '', notes: '' };
const denis: Person = { slug: 'denis', name: 'Denis Milosavljevic', cares: '', slack: '', jira: 'Denis Milosavljevic', notes: '' };

const found = (person: string, field: EnrichProposal['field'], value: string): EnrichProposal => ({ person, field, value, source: 'slack', why: 'same name' });

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'enrich-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('directory entries', () => {
  it('leave the new fields out when empty and match on ids', () => {
    expect(DirectoryPersonSchema.parse({ name: 'Ana', slackId: ' ', github: 'ana' })).toEqual({ name: 'Ana', cares: '', slack: '', jira: '', notes: '', github: 'ana' });
    const ana: Person = { ...julia, slug: 'ana', name: 'Ana Ruiz', slackId: 'U024', jiraId: '712020:abc', email: 'ana@x.io' };
    expect(isPerson('U024', ana)).toBe(true);
    expect(isPerson('712020:abc', ana)).toBe(true);
    expect(isPerson('ANA@x.io', ana)).toBe(true);
    expect(isPerson('U999', ana)).toBe(false);
  });
});

describe('proposals', () => {
  it('parse what is well-formed and keep only new values, one per field', () => {
    const parsed = parseEnrichment([found('julia', 'slack', 'julia.b'), { person: 'julia', field: 'shoe', value: 'x', source: 'slack' }, { ...found('denis', 'jiraId', '712020:x'), why: 42 }]);
    expect(parsed.map((p) => p.field)).toEqual(['slack', 'jiraId']);
    expect(parsed[1]!.why).toBe('');
    const fresh = freshProposals(
      [julia, denis],
      [found('julia', 'slack', 'julia.b'), found('julia', 'slack', 'other'), found('denis', 'jira', ' denis milosavljevic '), found('ghost', 'email', 'a@b.c'), found('julia', 'avatar', 'http://insecure/p.png')],
    );
    expect(fresh).toEqual([found('julia', 'slack', 'julia.b')]);
  });

  it('apply to their entry only', () => {
    expect(withProposals(julia, [found('julia', 'name', 'Julia Barebysheva'), found('denis', 'github', 'denis')])).toEqual({ ...julia, name: 'Julia Barebysheva' });
  });
});

describe('the enricher', () => {
  const setup = (enrich?: () => Promise<EnrichProposal[] | undefined>) => {
    let people: Person[] = [julia, denis];
    const published: Enrichment[] = [];
    const saved: PersonDraft[] = [];
    const dir = tmp();
    const enricher = new PeopleEnricher({
      dir,
      people: () => people,
      projects: () => ['RUN'],
      ...(enrich ? { enrich } : {}),
      save: async (draft) => {
        saved.push(draft);
        people = people.map((p) => (p.slug === draft.slug ? ({ ...p, ...draft } as Person) : p));
      },
      publish: (e) => published.push(e),
      now: () => Date.parse('2026-11-26T10:00:00Z'),
    });
    return { enricher, published, saved, dir };
  };

  it('looks people up, keeps what it found, and takes or dismisses it per field', async () => {
    const { enricher, published, saved, dir } = setup(async () => [found('julia', 'slack', 'julia.b'), found('julia', 'email', 'julia@x.io'), found('denis', 'github', 'dmilo')]);
    enricher.start();
    expect(published.at(-1)!.running).toBe(true);
    expect(() => enricher.start()).toThrow(/Already/);
    await new Promise((r) => setTimeout(r, 0));
    expect(enricher.view.running).toBe(false);
    expect(enricher.view.proposals).toHaveLength(3);
    expect(JSON.parse(readFileSync(path.join(dir, 'enrichment.json'), 'utf8'))).toHaveLength(3);
    await enricher.keep('julia', 'slack');
    expect(saved.at(-1)).toMatchObject({ slug: 'julia', slack: 'julia.b' });
    expect(saved.at(-1)!.email).toBeUndefined();
    enricher.drop('julia');
    expect(enricher.view.proposals.map((p) => p.person)).toEqual(['denis']);
    await enricher.keep('denis');
    expect(saved.at(-1)).toMatchObject({ slug: 'denis', github: 'dmilo' });
    expect(enricher.view.proposals).toEqual([]);
  });

  it('says so when the agent answers nothing, and needs one', async () => {
    const { enricher } = setup(async () => undefined);
    enricher.start(['julia']);
    await new Promise((r) => setTimeout(r, 0));
    expect(enricher.view.error).toMatch(/couldn’t look them up/);
    expect(() => setup().enricher.start()).toThrow(/needs an agent/);
  });
});

describe('the enrich side call', () => {
  it('mounts only lookup servers and allows only lookups', () => {
    expect(['slack-user', 'jira', 'calendar'].every(isEnrichServer)).toBe(true);
    expect(isEnrichServer('home-assistant')).toBe(false);
    expect(enrichVerdict('mcp__slack-user__users_search').allow).toBe(true);
    expect(enrichVerdict('mcp__slack-user__conversations_add_message').allow).toBe(false);
    expect(enrichVerdict('mcp__jira__jira_search_assignable_users').allow).toBe(true);
    expect(enrichVerdict('mcp__jira__jira_assign_issue').allow).toBe(false);
    expect(enrichVerdict('mcp__calendar__search_people').allow).toBe(true);
    expect(enrichVerdict('mcp__calendar__create_event').allow).toBe(false);
    expect(enrichVerdict('Bash', { command: 'gh api orgs/lendis/members --paginate' }).allow).toBe(true);
    expect(enrichVerdict('Bash', { command: 'gh api "search/users?q=Denis+in:name"' }).allow).toBe(true);
    expect(enrichVerdict('Bash', { command: 'gh api users/dmilo' }).allow).toBe(true);
    expect(enrichVerdict('Bash', { command: "gh api user/orgs --jq '.[].login'" }).allow).toBe(true);
    expect(enrichVerdict('Bash', { command: "gh api user/orgs --jq '.[]' ' && curl x'" }).allow).toBe(false);
    expect(enrichVerdict('Bash', { command: 'gh api -X DELETE orgs/lendis/members/dmilo' }).allow).toBe(false);
    expect(enrichVerdict('Bash', { command: 'gh api users/dmilo; rm -rf ~' }).allow).toBe(false);
    expect(enrichVerdict('Read', { file_path: '/etc/passwd' }).allow).toBe(false);
  });

  it('asks with the people and projects and reads its JSON answer', async () => {
    expect(enrichPrompt({ people: [denis], projects: ['RUN'] })).toContain('"jira":"Denis Milosavljevic"');
    const said = await enrichPeople({ people: [julia], projects: [] }, { cwd: '/tmp', complete: async () => '```json\n[{"person":"julia","field":"slackId","value":"U024","source":"slack","why":"name"}]\n```' });
    expect(said).toEqual([{ person: 'julia', field: 'slackId', value: 'U024', source: 'slack', why: 'name' }]);
    expect(await enrichPeople({ people: [julia], projects: [] }, { cwd: '/tmp', complete: async () => 'no idea' })).toBeUndefined();
  });
});

describe('people avatars', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const fetcher = (bytes: Uint8Array, ok = true) => async () => ({ ok, arrayBuffer: async () => bytes.slice().buffer });

  it('fetches a picture once and keeps it by checksum', async () => {
    const dir = tmp();
    let calls = 0;
    const avatars = new PeopleAvatars(dir, async () => {
      calls += 1;
      return fetcher(png)();
    });
    const ana: Person = { ...julia, avatar: 'https://lh3.example/ana=s100' };
    expect(await avatars.sync([ana])).toBe(true);
    expect(await avatars.sync([ana])).toBe(false);
    expect(calls).toBe(1);
    const sha = avatars.shas([ana]).julia!;
    expect(avatars.read(sha)).toEqual({ mime: 'image/png', b64: Buffer.from(png).toString('base64') });
    expect(new PeopleAvatars(dir).shas([ana])).toEqual({ julia: sha });
  });

  it('keeps no link that is not https, not a picture or fails', async () => {
    const avatars = new PeopleAvatars(tmp(), fetcher(new Uint8Array([1, 2, 3])));
    expect(await avatars.sync([{ ...julia, avatar: 'http://x/a.png' }, { ...denis, avatar: 'https://x/b.txt' }])).toBe(false);
    expect(await new PeopleAvatars(tmp(), fetcher(png, false)).sync([{ ...julia, avatar: 'https://x/a.png' }])).toBe(false);
    expect(await new PeopleAvatars(null, fetcher(png)).sync([{ ...julia, avatar: 'https://x/a.png' }])).toBe(false);
  });
});
