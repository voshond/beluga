import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { keepProposal, readDirectory, writePerson } from '../src/core/initiatives/directory.js';
import { listSlugs, readFolder } from '../src/core/initiatives/files.js';
import { Initiatives } from '../src/core/initiatives/initiatives.js';
import { CHECK_IN_CHAT, InitiativeConfigSchema, type InitiativeView, SuggestionSchema, initiativeChatChannel } from '../src/core/initiatives/model.js';
import { type Person, isPerson, lastContact, membersOf, needsPeoplePass, peopleAcross, waitingOnThem, waitingOnYou, waitingQuestionsOf } from '../src/core/initiatives/people.js';
import { PEOPLE_PASS, peopleBrief } from '../src/core/initiatives/people-prompt.js';
import { CHECK_IN_PROMPT } from '../src/core/initiatives/prompt.js';
import { Store, initialState } from '../src/core/store.js';

const SELF = 'peer-12345678';
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-people-'));

const julia: Person = { slug: 'julia-barebysheva', name: 'Julia Barebysheva', cares: 'Rollout steps', slack: '@julia', jira: 'jbare', notes: '' };

const view = (over: Partial<InitiativeView>): InitiativeView =>
  ({ slug: 'device-enrollment', name: 'Device Enrollment', status: 'active', people: [], suggestions: [], timeline: [], files: [], ...over }) as InitiativeView;

const setup = async (commit = false) => {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true, home: '/Users/k' });
  const root = path.join(tmp(), 'initiatives');
  const asked: Array<{ readonly prompt: string; readonly channel: string }> = [];
  const service = new Initiatives({
    store,
    root,
    dir: tmp(),
    selfId: () => SELF,
    ask: (prompt, channel) => {
      asked.push({ prompt, channel });
      return `r${asked.length}`;
    },
    commit,
    claudeDir: tmp(),
  });
  await service.start();
  return { store, root, asked, service };
};

describe('initiative.json people', () => {
  it('reads the old { name, role } as a reference to the slug of the name, and the new { person, role }', () => {
    const config = InitiativeConfigSchema.parse({ name: 'X', people: [{ name: 'Julia Barebysheva', role: 'Ops' }, { person: 'denis', role: ' Engineering ' }, { person: 'omer' }] });
    expect(config.people).toEqual([{ person: 'julia-barebysheva', name: 'Julia Barebysheva', role: 'Ops' }, { person: 'denis', role: 'Engineering' }, { person: 'omer' }]);
    expect(InitiativeConfigSchema.parse({ name: 'X' }).people).toEqual([]);
    expect(() => InitiativeConfigSchema.parse({ name: 'X', people: [{ role: 'nobody' }] })).toThrow();
  });

  it('keeps waitingOn, askedBy and a people proposal on a suggestion, and reads kind "people" as other', () => {
    const parsed = SuggestionSchema.parse({ id: 1, text: 'Add 2 people', kind: 'people', waitingOn: null, askedBy: 'julia-barebysheva', people: [{ name: 'Julia', role: 'Ops', slack: null }] });
    expect(parsed).toMatchObject({ kind: 'other', askedBy: 'julia-barebysheva', people: [{ name: 'Julia', role: 'Ops' }] });
  });
});

describe('people', () => {
  it('finds decisions.md open questions marked as waiting on someone', () => {
    const md = '# Decisions\n\n## Open\n\n- Who owns sample lists? (waiting on: Julia Barebysheva)\n- Plain question\n\n## Decided\n\n- Done thing (waiting on: Ana)\n';
    expect(waitingQuestionsOf(md)).toEqual([{ text: 'Who owns sample lists?', waitingOn: 'Julia Barebysheva' }]);
    expect(waitingQuestionsOf('## Open\n\n- 2026-11-23: Flag guest checkout? (waiting on: Ana Ruiz)\n')).toEqual([{ text: 'Flag guest checkout?', waitingOn: 'Ana Ruiz' }]);
    expect(waitingQuestionsOf('no headings')).toEqual([]);
  });

  it('knows a person by slug, name or handle', () => {
    expect(isPerson('julia-barebysheva', julia)).toBe(true);
    expect(isPerson('Julia Barebysheva', julia)).toBe(true);
    expect(isPerson('@julia', julia)).toBe(true);
    expect(isPerson('JBARE', julia)).toBe(true);
    expect(isPerson('Julian', julia)).toBe(false);
    expect(isPerson(undefined, julia)).toBe(false);
  });

  it('derives what waits on them, what they wait on, and the last contact from the timeline', () => {
    const item = view({
      suggestions: [
        SuggestionSchema.parse({ id: 1, text: 'Get the supplier list', waitingOn: 'Julia Barebysheva' }),
        SuggestionSchema.parse({ id: 2, text: 'Send Julia the rollout plan', askedBy: 'julia-barebysheva' }),
        SuggestionSchema.parse({ id: 3, text: 'Old one', waitingOn: 'julia-barebysheva', state: 'approved' }),
      ],
      waitingQuestions: [{ text: 'MDM first?', waitingOn: 'julia' }],
      timeline: [
        { day: '2026-11-25', kind: 'check-in', text: 'Julia was mentioned' },
        { day: '2026-11-20', kind: 'said', text: 'Julia: MDM on Friday' },
        { day: '2026-11-22', kind: 'meeting', text: 'Rollout sync with Julia Barebysheva' },
        { day: '2026-11-24', kind: 'said', text: 'Julian: unrelated' },
      ],
    });
    expect(waitingOnThem(item, julia).map((w) => w.text)).toEqual(['Get the supplier list', 'MDM first?']);
    expect(waitingOnYou(item, julia).map((w) => w.suggestion)).toEqual([2]);
    expect(lastContact(item.timeline, julia)).toBe('2026-11-22');
    expect(lastContact([], julia)).toBeUndefined();
  });

  it('lists people across initiatives with their roles, the most open first', () => {
    const ana: Person = { slug: 'ana', name: 'Ana', cares: '', slack: '', jira: '', notes: '' };
    const a = view({ people: [{ person: 'julia-barebysheva', role: 'Ops' }, { person: 'ana' }], suggestions: [SuggestionSchema.parse({ id: 1, text: 'Ask Ana', waitingOn: 'ana' })] });
    const b = view({ slug: 'e-invoicing', name: 'e-Invoicing', people: [{ person: 'ana', role: 'Finance' }], suggestions: [SuggestionSchema.parse({ id: 4, text: 'Reply to Ana', askedBy: 'ana' })] });
    const archived = view({ slug: 'old', status: 'archived', people: [{ person: 'ana' }], suggestions: [SuggestionSchema.parse({ id: 1, text: 'Gone', waitingOn: 'ana' })] });
    const all = peopleAcross([julia, ana], [a, b, archived]);
    expect(all.map((p) => p.person.slug)).toEqual(['ana', 'julia-barebysheva']);
    expect(all[0]!.roles).toEqual([{ initiative: 'device-enrollment', initiativeName: 'Device Enrollment' }, { initiative: 'e-invoicing', initiativeName: 'e-Invoicing', role: 'Finance' }]);
    expect(all[0]!.waitingOnThem.map((w) => w.text)).toEqual(['Ask Ana']);
    expect(all[0]!.waitingOnYou.map((w) => w.initiativeName)).toEqual(['e-Invoicing']);
    expect(membersOf(a, [julia]).map((m) => m.name)).toEqual(['Julia Barebysheva', 'ana']);
  });

  it('wants the people.md pass only until there are people or a people suggestion', () => {
    expect(needsPeoplePass(view({ files: ['people.md'] }))).toBe(true);
    expect(needsPeoplePass(view({ files: ['people.md'], people: [{ person: 'x' }] }))).toBe(false);
    expect(needsPeoplePass(view({ files: ['people.md'], suggestions: [SuggestionSchema.parse({ id: 1, text: 'Add', people: [{ name: 'X' }], state: 'dismissed' })] }))).toBe(false);
  });

  it('tells the agent about people in the brief and the check-in', () => {
    const brief = peopleBrief({ people: [{ person: 'julia-barebysheva', role: 'Ops' }] }, [julia]);
    expect(brief).toContain('- Julia Barebysheva: Ops (slug julia-barebysheva)');
    expect(brief).toContain('"waitingOn"');
    expect(CHECK_IN_PROMPT).toContain('(waiting on: <their name>)');
    expect(CHECK_IN_PROMPT).toContain('"askedBy"');
    expect(PEOPLE_PASS).toContain('people.md');
  });
});

describe('the directory', () => {
  it('writes one file per person at the repo root, which is never read as an initiative', () => {
    const root = tmp();
    const slug = writePerson(root, { name: 'Ömer Kaya', slack: '@omer' });
    expect(slug).toBe('omer-kaya');
    expect(writePerson(root, { name: 'Ömer Kaya' })).toBe('omer-kaya-2');
    expect(JSON.parse(readFileSync(path.join(root, 'people', 'omer-kaya.json'), 'utf8'))).toEqual({ name: 'Ömer Kaya', cares: '', slack: '@omer', jira: '', notes: '' });
    expect(existsSync(path.join(root, 'people', 'README.md'))).toBe(true);
    writeFileSync(path.join(root, 'people', 'broken.json'), '{');
    expect(readDirectory(root).map((p) => p.slug)).toEqual(['omer-kaya', 'omer-kaya-2']);
    expect(listSlugs(root)).toEqual([]);
  });

  it('folds a proposal into an entry with the same name, keeping what it had', () => {
    const root = tmp();
    writePerson(root, { name: 'Julia Barebysheva', cares: 'Rollout steps' });
    expect(keepProposal(root, { name: 'julia barebysheva', cares: 'Something else', slack: '@julia' })).toBe('julia-barebysheva');
    expect(readDirectory(root)[0]).toMatchObject({ cares: 'Rollout steps', slack: '@julia' });
  });
});

describe('Initiatives and people', () => {
  it('adds, edits and removes people and their role, committing the directory and the folder', async () => {
    const { store, root, service } = await setup(true);
    const { slug } = await service.create({ name: 'Device Enrollment' });
    const made = await service.savePerson({ name: 'Julia Barebysheva', cares: 'Rollout' });
    expect(store.getState().initiatives.people?.map((p) => p.slug)).toEqual([made.slug]);
    await service.setPerson(slug, made.slug, 'Ops');
    await service.setPerson(slug, made.slug, 'Ops lead');
    expect(readFolder(root, slug).config?.people).toEqual([{ person: 'julia-barebysheva', role: 'Ops lead' }]);
    await expect(service.removePerson(made.slug)).rejects.toThrow(/Take them off Device Enrollment first/);
    await expect(service.setPerson(slug, 'nobody', 'x')).rejects.toThrow(/not in the directory/);
    await service.setPerson(slug, made.slug, null);
    expect(store.getState().initiatives.items[0]!.people).toEqual([]);
    await service.removePerson(made.slug);
    expect(store.getState().initiatives.people).toEqual([]);
    const log = execFileSync('git', ['log', '--format=%s'], { cwd: root, encoding: 'utf8' });
    expect(log).toContain('people: julia-barebysheva saved');
    expect(log).toContain('people: julia-barebysheva removed');
  });

  it('never makes an initiative called people', async () => {
    const { service } = await setup();
    expect((await service.create({ name: 'People' })).slug).toBe('people-2');
  });

  it('asks the Check-in chat for the one-time pass, and writes the directory only when its suggestion is approved', async () => {
    const { store, root, asked, service } = await setup();
    const { slug } = await service.create({ name: 'Device Enrollment' });
    expect(service.proposePeople(slug)).toEqual({ channel: initiativeChatChannel(slug, CHECK_IN_CHAT) });
    expect(asked.at(-1)?.prompt).toBe(PEOPLE_PASS);
    writeFileSync(
      path.join(root, slug, 'suggestions.json'),
      JSON.stringify([{ id: 1, text: 'Add 2 people from people.md', kind: 'people', state: 'open', people: [{ name: 'Julia Barebysheva', role: 'Ops', cares: 'Rollout' }, { name: 'Denis Milosavljevic', role: 'Engineering' }] }]),
    );
    service.refresh(slug);
    expect(readDirectory(root)).toEqual([]);
    const before = asked.length;
    expect(await service.resolveSuggestion(slug, 1, 'approve')).toEqual({});
    expect(asked.length).toBe(before);
    expect(readDirectory(root).map((p) => p.slug)).toEqual(['denis-milosavljevic', 'julia-barebysheva']);
    const item = store.getState().initiatives.items[0]!;
    expect(item.people).toEqual([{ person: 'julia-barebysheva', role: 'Ops' }, { person: 'denis-milosavljevic', role: 'Engineering' }]);
    expect(item.suggestions[0]).toMatchObject({ state: 'approved', outcome: 'Added 2 people to the directory and this initiative.' });
  });

  it('shows decisions.md questions waiting on someone on the view', async () => {
    const { store, root, service } = await setup();
    const { slug } = await service.create({ name: 'E' });
    writeFileSync(path.join(root, slug, 'decisions.md'), '# Decisions\n\n## Open\n\n- MDM first? (waiting on: André)\n\n## Decided\n');
    service.refresh(slug);
    expect(store.getState().initiatives.items[0]!.waitingQuestions).toEqual([{ text: 'MDM first?', waitingOn: 'André' }]);
  });
});
