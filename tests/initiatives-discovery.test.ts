import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedDemoInitiatives } from '../src/core/initiatives/demo.js';
import { proposedEpicKeys } from '../src/core/initiatives/discovery-model.js';
import { DISCOVERY_CHECK_IN_PROMPT, discoveryStepPrompt } from '../src/core/initiatives/discovery-prompt.js';
import { type CheckInHost, Initiatives, OUTBOX_DENIED } from '../src/core/initiatives/initiatives.js';
import { CHECK_IN_CHAT, InitiativeConfigSchema, initiativeChatChannel, matchesDraft } from '../src/core/initiatives/model.js';
import { CHECK_IN_PROMPT, CHECK_IN_WAKE, TICKETS_PROMPT, checkInPromptFor, initiativeBrief } from '../src/core/initiatives/prompt.js';
import { initiativeReportFor } from '../src/core/initiatives/report.js';
import type { SentinelDraft } from '../src/core/sentinel/model.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';

const SELF = 'peer-12345678';
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-discovery-'));

const setup = async () => {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true, home: '/Users/k' });
  const root = path.join(tmp(), 'initiatives');
  const drafts: SentinelDraft[] = [];
  const host: CheckInHost = {
    create: (draft) => {
      drafts.push(draft);
      return { id: `sn${drafts.length}` };
    },
    exists: () => false,
    pause: () => undefined,
    runNow: () => undefined,
    reschedule: () => undefined,
    remove: () => undefined,
  };
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
    checkIns: () => host,
    commit: false,
    claudeDir: tmp(),
  });
  await service.start();
  const item = (slug: string) => store.getState().initiatives.items.find((i) => i.slug === slug)!;
  const put = (slug: string, name: string, text: string): void => {
    mkdirSync(path.dirname(path.join(root, slug, name)), { recursive: true });
    writeFileSync(path.join(root, slug, name), text);
    service.refresh(slug);
  };
  return { store, root, drafts, asked, service, item, put };
};

const main = (slug: string): string => initiativeChatChannel(slug, 'main');

describe('the discovery stage', () => {
  it('starts an initiative in discovery with no epic, and leaves one without a status active', async () => {
    const { service, item, drafts } = await setup();
    const { slug } = await service.create({ name: 'Returns', status: 'discovery' });
    expect(item(slug)).toMatchObject({ status: 'discovery', epics: [], discovery: {} });
    expect(drafts[0]?.steps?.[0]).toMatchObject({ kind: 'chat', text: CHECK_IN_WAKE });
    const { slug: other } = await service.create({ name: 'Checkout' });
    expect(item(other).status).toBe('active');
    expect(item(other).discovery).toBeUndefined();
    expect(InitiativeConfigSchema.parse({ name: 'Live', epics: ['ENR-1'] }).status).toBe('active');
  });

  it('reads what discovery worked out, and a broken demo.json as trouble', async () => {
    const { service, item, put } = await setup();
    const { slug } = await service.create({ name: 'Returns', status: 'discovery' });
    put(slug, 'problem.md', '# Problem\n\nSupport prints labels.\n');
    put(slug, 'prd.md', '# PRD\n');
    put(slug, 'proposal.json', JSON.stringify({ epics: [{ title: 'Returns', key: 'ret-1', stories: [{ title: 'Label' }] }, { title: 'Tracking', key: 'later' }] }));
    put(slug, 'demo.json', JSON.stringify({ repo: 'web', task: 'web-12', state: 'cooking' }));
    const discovery = item(slug).discovery!;
    expect(discovery.problem?.text).toContain('Support prints labels.');
    expect(discovery.prd?.text).toBe('# PRD');
    expect(discovery.demo).toEqual({ repo: 'web', task: 'WEB-12', title: undefined, state: 'drafted' });
    expect(proposedEpicKeys(discovery.proposal)).toEqual(['RET-1']);
    put(slug, 'demo.json', '{ nope');
    expect(item(slug).discovery?.trouble).toMatch(/demo.json is not valid JSON/);
  });

  it('sends each step into the work chat, and refuses one out of discovery or for an unlinked repo', async () => {
    const { service, asked } = await setup();
    const { slug } = await service.create({ name: 'Returns', status: 'discovery', repos: ['web'] });
    expect(service.discoveryStep(slug, { step: 'size', question: 'How many returns by email?' })).toEqual({ channel: main(slug) });
    expect(asked[0]!.prompt).toContain('Size it: How many returns by email?');
    expect(asked[0]!.prompt).toContain('sentinel_try_source');
    service.discoveryStep(slug, { step: 'demo', repo: 'web' });
    expect(asked[1]!.prompt).toBe(discoveryStepPrompt({ step: 'demo', repo: 'web' }));
    expect(asked[1]!.prompt).toMatch(/task_create, project "web"/);
    expect(asked[1]!.prompt).toMatch(/Only when the user decides “Start it”, call task_start/);
    expect(() => service.discoveryStep(slug, { step: 'demo', repo: 'app' })).toThrow(/Link app first/);
    const { slug: active } = await service.create({ name: 'Checkout' });
    expect(() => service.discoveryStep(active, { step: 'prd' })).toThrow(/in discovery/);
  });

  it('keeps each sizing finding as an artifact with its query when the chat’s turn ends', async () => {
    const { service, store, root, item, put } = await setup();
    const { slug } = await service.create({ name: 'Returns', status: 'discovery' });
    put(slug, 'sizing/return-emails.md', '# How many return emails?\n\n1,840 a month.\n\n```sql\nSELECT 1\n```\n');
    store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'done', text: 'ok', ts: Date.now(), channel: main(slug) });
    await waitFor(() => item(slug).artifacts.length === 1);
    expect(item(slug).artifacts[0]).toMatchObject({ id: 1, title: 'How many return emails?', about: 'sizing', from: 'Size It', file: 'artifacts/1-return-emails.md' });
    expect(readFileSync(path.join(root, slug, 'artifacts/1-return-emails.md'), 'utf8')).toContain('SELECT 1');
    expect(existsSync(path.join(root, slug, 'sizing/return-emails.md'))).toBe(false);
  });

  it('brings a demo worktree’s proof back as a demo artifact', async () => {
    const { service, store, root, item, put } = await setup();
    const { slug } = await service.create({ name: 'Returns', status: 'discovery' });
    put(slug, 'demo.json', JSON.stringify({ repo: 'web', task: 'WEB-12', state: 'started' }));
    const proof = path.join(tmp(), 'walkthrough.md');
    writeFileSync(proof, '# Walkthrough\n');
    const report = initiativeReportFor(service, store.getState().initiatives.items, { name: 'web-12-returns-demo', path: root })!;
    await report.report({ file: proof, title: 'Walkthrough' });
    expect(item(slug).artifacts[0]).toMatchObject({ ticket: 'WEB-12', about: 'demo' });
  });

  it('moves to delivery only with the epics created, linking them and reading their tickets', async () => {
    const { service, asked, item, put, root } = await setup();
    const { slug } = await service.create({ name: 'Returns', status: 'discovery' });
    await expect(service.promote(slug)).rejects.toThrow(/No epics yet/);
    put(slug, 'proposal.json', JSON.stringify({ epics: [{ title: 'Returns', key: 'RET-1' }, { title: 'Tracking' }] }));
    await service.promote(slug);
    expect(item(slug)).toMatchObject({ status: 'active', epics: ['RET-1'] });
    expect(item(slug).discovery).toBeUndefined();
    expect(asked.at(-1)!.prompt).toBe(TICKETS_PROMPT);
    expect(readFileSync(path.join(root, slug, 'timeline.md'), 'utf8')).toMatch(/\[decision\]: moved from discovery to delivery with RET-1/);
    await expect(service.promote(slug)).rejects.toThrow(/Only an initiative in discovery/);
  });

  it('checks in on evidence, questions and the demo instead of tickets while in discovery', async () => {
    const { service, item } = await setup();
    const { slug } = await service.create({ name: 'Returns', status: 'discovery' });
    expect(checkInPromptFor(item(slug))).toBe(DISCOVERY_CHECK_IN_PROMPT);
    expect(DISCOVERY_CHECK_IN_PROMPT).toMatch(/skip Jira tickets entirely/);
    const brief = initiativeBrief(item(slug), '', [], CHECK_IN_CHAT);
    expect(brief).toContain(DISCOVERY_CHECK_IN_PROMPT);
    expect(brief).not.toContain(CHECK_IN_PROMPT);
    expect(brief).toContain('This initiative is in discovery');
    expect(checkInPromptFor({ status: 'active' })).toBe(CHECK_IN_PROMPT);
  });

  it('sends the PRD to Confluence only as the outbox draft the user sent, with the file as it is', async () => {
    const { service, item, put } = await setup();
    const { slug } = await service.create({ name: 'Returns', status: 'discovery' });
    put(slug, 'prd.md', '# PRD\n\nReturns.\n');
    put(slug, 'outbox.json', JSON.stringify([{ id: 1, to: { kind: 'confluence', file: 'prd.md', title: 'Returns PRD', space: 'SHOP' }, text: 'The PRD as a page in SHOP' }]));
    const run = service.chatRun(main(slug), SELF)!;
    const create = { space_key: 'SHOP', title: 'Returns PRD', content: '# PRD\n\nReturns.\n', content_format: 'markdown' };
    expect(run.vetTool('mcp__jira__confluence_create_page', create)).toBe(OUTBOX_DENIED);
    await service.sendDraft(slug, 1, 'The PRD as a page in SHOP');
    expect(run.vetTool('mcp__jira__confluence_create_page', { ...create, content: 'Something else' })).toBe(OUTBOX_DENIED);
    expect(run.vetTool('mcp__jira__confluence_create_page', create)).toBeUndefined();
    expect(item(slug).outbox[0]!.state).toBe('sent');
    expect(matchesDraft({ kind: 'confluence', file: 'prd.md', title: 'T', page: '42' }, 'x', 'confluence_update_page', { page_id: '42', title: 'T', content: 'x' })).toBe(true);
    expect(matchesDraft({ kind: 'confluence', file: 'prd.md', title: 'T', page: '42' }, 'x', 'confluence_create_page', { space_key: 'S', title: 'T', content: 'x' })).toBe(false);
  });

  it('seeds a demo initiative in discovery with every section', async () => {
    const { service, root, item } = await setup();
    await seedDemoInitiatives(service, root);
    const returns = item('self-serve-returns');
    expect(returns.status).toBe('discovery');
    expect(returns.discovery?.problem && returns.discovery.evidence && returns.discovery.prd).toBeTruthy();
    expect(returns.discovery?.demo).toMatchObject({ task: 'WEB-12', state: 'started' });
    expect(returns.artifacts.map((a) => a.about)).toEqual(['sizing', 'demo']);
    expect(returns.trouble).toBeUndefined();
  });
});
