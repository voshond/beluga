import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Initiatives } from '../src/core/initiatives/initiatives.js';
import { CHECK_IN_CHAT, type Ticket, TicketSchema, TicketsSchema, initiativeChatChannel } from '../src/core/initiatives/model.js';
import { CHECK_IN_PROMPT, TICKETS_PROMPT, initiativeBrief } from '../src/core/initiatives/prompt.js';
import { type Risk, RisksSchema, blockerRisks, blockersOf, closedRisks, openRisks, outsideBlockers, riskOf, withOwnerEdits } from '../src/core/initiatives/risks.js';
import { Store, initialState } from '../src/core/store.js';
import { waitFor } from './helpers.js';

const SELF = 'peer-12345678';
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-risks-'));

const ticket = (key: string, extra: Record<string, unknown> = {}): Ticket => TicketSchema.parse({ key, summary: key, status: 'To Do', statusCategory: 'todo', ...extra });

const risks = (raw: readonly Record<string, unknown>[]): Risk[] => RisksSchema.parse(raw);

describe('risks.json', () => {
  it('reads forgivingly: missing or odd severity and state fall back, sources default', () => {
    const [a, b] = risks([{ id: 1, title: 'A', severity: 'High', state: 'WATCHING' }, { id: 2, title: 'B', severity: 'huge' }]);
    expect(a).toMatchObject({ severity: 'high', state: 'watching', sources: [] });
    expect(b).toMatchObject({ severity: 'medium', state: 'open' });
  });

  it('shows the owner’s edit over the agent’s, an empty one clearing the field', () => {
    const [risk] = risks([{ id: 1, title: 'Agent', severity: 'low', owner: 'Ana', mitigation: 'wait', owned: { severity: 'high', owner: '', title: 'Mine' } }]);
    expect(riskOf(risk!)).toMatchObject({ title: 'Mine', severity: 'high', owner: undefined, mitigation: 'wait' });
  });

  it('lists open and watched risks by severity, closed ones apart', () => {
    const list = risks([
      { id: 1, title: 'low', severity: 'low' },
      { id: 2, title: 'watched high', severity: 'high', state: 'watching' },
      { id: 3, title: 'open high', severity: 'high' },
      { id: 4, title: 'closed', severity: 'high', state: 'closed', closedAt: '2026-11-20' },
      { id: 5, title: 'closed by owner', severity: 'low', owned: { state: 'closed', at: '2026-11-25' } },
    ]);
    expect(openRisks(list).map((r) => r.id)).toEqual([3, 2, 1]);
    expect(closedRisks(list).map((r) => r.id)).toEqual([5, 4]);
  });

  it('puts the owner’s edits back where a turn changed or dropped them', () => {
    const kept = risks([{ id: 1, title: 'Mine', owned: { severity: 'high' } }, { id: 2, title: 'Gone', owned: { title: 'Gone' } }]);
    const now = risks([{ id: 1, title: 'Mine', severity: 'low' }, { id: 3, title: 'New' }]);
    const back = withOwnerEdits(now, kept);
    expect(back.changed).toBe(true);
    expect(back.risks.map((r) => r.id)).toEqual([1, 3, 2]);
    expect(riskOf(back.risks[0]!).severity).toBe('high');
    expect(withOwnerEdits(back.risks, kept).changed).toBe(false);
  });
});

describe('ticket links', () => {
  it('keeps Blocks links as either side says them and drops other types', () => {
    const read = ticket('A-1', { links: [{ type: 'is blocked by', key: 'X-9', status: 'In Progress', statusCategory: 'indeterminate' }, { type: 'relates to', key: 'A-2' }, { type: 'blocks', key: 'A-3' }] });
    expect(read.links).toEqual([expect.objectContaining({ type: 'blockedBy', key: 'X-9', statusCategory: 'inProgress' }), expect.objectContaining({ type: 'blocks', key: 'A-3' })]);
    expect(ticket('A-2').links).toBeUndefined();
  });

  it('finds what blocks a ticket from both sides, with the freshest status, and marks the ones outside', () => {
    const tickets = [ticket('A-1', { links: [{ type: 'blockedBy', key: 'X-9', status: 'In Progress', statusCategory: 'inProgress' }] }), ticket('A-2', { status: 'Done', statusCategory: 'done', links: [{ type: 'blocks', key: 'A-1' }] })];
    expect(blockersOf(tickets[0]!, tickets)).toEqual([
      expect.objectContaining({ key: 'X-9', status: 'In Progress', outside: true }),
      expect.objectContaining({ key: 'A-2', status: 'Done', statusCategory: 'done', outside: false }),
    ]);
    expect(outsideBlockers(tickets)).toEqual([expect.objectContaining({ blocker: expect.objectContaining({ key: 'X-9' }), blocks: ['A-1'] })]);
  });

  it('raises a risk for an open outside blocker no risk names yet', () => {
    const tickets = [ticket('A-1', { links: [{ type: 'blockedBy', key: 'X-9', summary: 'Rates', status: 'In Progress' }] }), ticket('A-2', { links: [{ type: 'blockedBy', key: 'X-9' }] })];
    const raised = blockerRisks(tickets, risks([{ id: 4, title: 'Other' }]), '2026-11-26T08:00:00Z');
    expect(raised).toEqual([expect.objectContaining({ id: 5, blocker: 'X-9', state: 'open', title: expect.stringContaining('X-9'), why: expect.stringContaining('A-1, A-2 are blocked by X-9 (Rates)') })]);
    expect(blockerRisks(tickets, risks([{ id: 1, title: 'Finance (x-9) is late', state: 'closed' }]), '')).toEqual([]);
    expect(blockerRisks([ticket('A-1', { statusCategory: 'done', links: [{ type: 'blockedBy', key: 'X-9' }] })], [], '')).toEqual([]);
  });
});

describe('prompts', () => {
  it('read the Blocks links with the tickets and keep risks in the check-in and the brief', () => {
    expect(TICKETS_PROMPT).toContain('"blockedBy"');
    expect(CHECK_IN_PROMPT).toContain('risks.json current');
    expect(CHECK_IN_PROMPT).toContain('[risk]');
  });
});

const setup = async () => {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true, home: '/Users/k' });
  const root = path.join(tmp(), 'initiatives');
  const service = new Initiatives({ store, root, dir: tmp(), selfId: () => SELF, ask: () => 'r1', commit: false, now: () => Date.parse('2026-11-26T09:00:00Z'), claudeDir: tmp() });
  await service.start();
  const { slug } = await service.create({ name: 'Checkout', epics: ['SHOP-1'] }, { quiet: true });
  const item = () => store.getState().initiatives.items.find((i) => i.slug === slug)!;
  const turnEnds = (): void => store.dispatch({ type: 'agent_event', owner: SELF, requestId: 'r1', requester: SELF, event: 'done', text: 'ok', ts: Date.now(), channel: initiativeChatChannel(slug, CHECK_IN_CHAT) });
  return { store, root, slug, service, item, turnEnds, file: (name: string) => path.join(root, slug, name) };
};

describe('Initiatives risks', () => {
  it('starts an initiative with an empty risks.json, and reads one without it', async () => {
    const { item, file } = await setup();
    expect(readFileSync(file('risks.json'), 'utf8')).toBe('[]\n');
    expect(item().risks).toEqual([]);
    expect(item().trouble).toBeUndefined();
  });

  it('keeps the owner’s added, changed and closed risks through a check-in that rewrites them', async () => {
    const { service, slug, item, turnEnds, file } = await setup();
    const { id } = await service.saveRisk(slug, { title: 'Finance is late', severity: 'high', state: 'open', owner: 'Ana' });
    expect(item().risks?.[0]).toMatchObject({ id, title: 'Finance is late', owned: expect.objectContaining({ severity: 'high', owner: 'Ana' }) });
    expect(item().timeline[0]).toMatchObject({ kind: 'risk', text: 'added risk 1 “Finance is late” on the page' });
    writeFileSync(file('risks.json'), JSON.stringify([{ id: 1, title: 'Finance is late', severity: 'low', state: 'closed' }, { id: 2, title: 'Agent risk' }]));
    turnEnds();
    await waitFor(() => item().risks?.length === 2 && riskOf(item().risks![0]!).severity === 'high');
    expect(riskOf(item().risks![0]!)).toMatchObject({ state: 'open', owner: 'Ana' });
    expect(item().risks).toHaveLength(2);
    await service.saveRisk(slug, { id, title: 'Finance is late', severity: 'high', state: 'closed' });
    expect(closedRisks(item().risks!)[0]).toMatchObject({ id, closedAt: '2026-11-26T09:00:00.000Z' });
    expect(item().timeline[0]?.text).toBe('closed risk 1 “Finance is late” on the page');
    writeFileSync(file('risks.json'), JSON.stringify([{ id: 2, title: 'Agent risk' }]));
    turnEnds();
    await waitFor(() => (item().risks ?? []).length === 2);
    expect(riskOf(item().risks!.find((r) => r.id === id)!).state).toBe('closed');
  });

  it('refuses to change a risk that is gone', async () => {
    const { service, slug } = await setup();
    await expect(service.saveRisk(slug, { id: 7, title: 'Nope', severity: 'low', state: 'open' })).rejects.toThrow('That risk is gone');
  });

  it('raises a risk, with a timeline line, for an open blocker outside the epics after a turn, once', async () => {
    const { item, turnEnds, file } = await setup();
    const tickets = TicketsSchema.parse({ at: '2026-11-26', tickets: [{ key: 'SHOP-2', epic: 'SHOP-1', links: [{ type: 'blockedBy', key: 'FIN-8', status: 'In Progress', statusCategory: 'inProgress' }] }] });
    writeFileSync(file('tickets.json'), JSON.stringify(tickets));
    turnEnds();
    await waitFor(() => (item().risks ?? []).length === 1);
    expect(item().risks![0]).toMatchObject({ blocker: 'FIN-8', state: 'open' });
    expect(item().timeline[0]).toMatchObject({ kind: 'risk', text: expect.stringContaining('raised risk 1 “Blocked by FIN-8') });
    turnEnds();
    await new Promise((r) => setTimeout(r, 50));
    expect(item().risks).toHaveLength(1);
  });

  it('tells every chat about risks.json', async () => {
    const { item } = await setup();
    expect(initiativeBrief(item(), '', [], 'main')).toContain('risks.json: what could sink it');
  });
});
