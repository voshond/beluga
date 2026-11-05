import { afterEach, describe, expect, it } from 'vitest';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { canAssign, offerWords, teamShareChoices, teammatesOf } from '../../src/core/team/model.js';
import { mergeRoster } from '../../src/core/team/roster.js';
import { answerFriendOffer } from '../../src/core/friend-offers.js';
import { type Crowd, LOSES_A_MESSAGE_ON_WINDOWS, befriend, crowd, settle } from '../mesh/helpers.js';
import { type PartsFor, type TeamMac, personOf, teamMac } from './helpers.js';

/** BLG-510: a team is one group: everyone sees everyone, any of them invites, leaving goes for all. */

let net: Crowd | undefined;
const macs: TeamMac[] = [];

afterEach(async () => {
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

const withSync: PartsFor = ({ team, board, dir }) => [new TeamBoardSync(team, { board, live: () => false, dir })];

async function teamUp(a: TeamMac, pa: string, b: TeamMac, pb: string): Promise<void> {
  await settle(() => a.store.getState().team.offers.find((o) => o.peerId === b.id && o.projectId === pa) && b.store.getState().team.offers.find((o) => o.peerId === a.id && o.projectId === pb));
  a.team.answer(b.id, pa, true);
  await settle(() => b.store.getState().team.offers.find((o) => o.peerId === a.id && o.state === 'invited'));
  b.team.answer(a.id, pb, true);
  await settle(() => a.store.getState().team.teams[pa]?.mates.some((m) => m.peerId === b.id) && b.store.getState().team.teams[pb]?.mates.some((m) => m.peerId === a.id));
}

const mates = (m: TeamMac, projectId: string) => teammatesOf(m.store.getState().team, projectId);
const names = (m: TeamMac, projectId: string) => mates(m, projectId).map((x) => x.name).sort();

describe('the roster', () => {
  it('keeps the newer line, leaving on a tie, and never a word about me', () => {
    const self = 's'.repeat(32);
    const ata = 'a'.repeat(32);
    const on = { peerId: ata, name: 'ata', since: 1, on: true, at: 5 };
    const r1 = mergeRoster({}, [on], self).roster;
    expect(mergeRoster(r1, [{ ...on, on: false, at: 4 }], self).won).toEqual([]);
    expect(mergeRoster(r1, [{ ...on, on: false, at: 5 }], self).roster[ata]?.on).toBe(false);
    expect(mergeRoster(r1, [{ peerId: self, name: 'me', since: 1, on: false, at: 99 }], self).won).toEqual([]);
  });
});

describe('a team of three', () => {
  it('everyone sees everyone, invites name the team, tasks go to anyone, and leaving goes for all', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync);
    const mia = await teamMac(net, 'mia', [{ id: 'pm', name: 'api', repo: 'acme/api' }], withSync);
    macs.push(ata, kay, mia);
    // kay and mia aren't friends: ata brings each of them in.
    await befriend(ata.person, kay.person);
    await befriend(ata.person, mia.person);
    await teamUp(ata, 'pa', kay, 'pk');

    // Ata's invite to mia says who's on the team.
    await settle(() => ata.store.getState().team.offers.find((o) => o.peerId === mia.id) && mia.store.getState().team.offers.find((o) => o.peerId === ata.id));
    expect(offerWords(ata.store.getState().team.offers.find((o) => o.peerId === mia.id)!)).toBe('mia also works on acme/api: invite them to the team');
    ata.team.answer(mia.id, 'pa', true);
    await settle(() => mia.store.getState().team.offers.find((o) => o.peerId === ata.id && o.state === 'invited'));
    expect(offerWords(mia.store.getState().team.offers.find((o) => o.peerId === ata.id)!)).toBe('ata invited you to the acme/api team, with kay');
    mia.team.answer(ata.id, 'pm', true);

    // Everyone sees everyone; kay and mia through ata.
    await settle(() => names(kay, 'pk').length === 2 && names(mia, 'pm').length === 2);
    expect(names(ata, 'pa')).toEqual(['kay', 'mia']);
    expect(names(kay, 'pk')).toEqual(['ata', 'mia']);
    expect(names(mia, 'pm')).toEqual(['ata', 'kay']);
    expect(mates(kay, 'pk').find((m) => m.peerId === mia.id)?.indirect).toBe(true);
    expect(kay.notices.some((n) => n.title === 'mia joined the acme/api team')).toBe(true);
    // A chat is still shared over your own link only.
    expect(teamShareChoices(kay.store.getState().team, undefined, 'pk').mates.map((m) => m.name)).toEqual(['ata']);

    // Kay gives mia a task: allowed, and it reaches her through ata.
    expect(canAssign(kay.store.getState().team, 'pk', kay.id, mia.id)).toBe(true);
    const t = kay.board.create({ projectId: 'pk', title: 'For mia', assignee: { kind: 'person', id: mia.id, name: 'mia' } }, personOf(kay));
    await settle(() => mia.board.get(t.id)?.assignee?.id === mia.id);

    // Kay asks mia to be friends from the team: it reaches her through ata; nothing until she accepts.
    await kay.team.befriend('pk', mia.id);
    await settle(() => mia.store.getState().network.offers?.some((o) => o.dir === 'in' && o.peerId === kay.id));
    expect(mia.notices.some((n) => n.title === 'kay from the acme/api team wants to add you as a friend')).toBe(true);
    expect(kay.person.mesh.isFriend(mia.id)).toBe(false);
    await answerFriendOffer({ store: mia.store, send: () => false }, mia.person.mesh, kay.id, true);
    await settle(() => kay.person.mesh.isFriend(mia.id));
    // Friends on one team link up by themselves: no offer to answer, and mia is no longer "through others".
    await settle(() => mates(kay, 'pk').find((m) => m.peerId === mia.id)?.indirect === undefined);
    expect(kay.store.getState().team.offers.filter((o) => o.peerId === mia.id)).toEqual([]);

    // Mia leaves the team: gone for everyone.
    mia.team.leave('pm');
    await settle(() => names(kay, 'pk').length === 1 && names(ata, 'pa').length === 1);
    expect(names(kay, 'pk')).toEqual(['ata']);
    expect(mates(mia, 'pm')).toEqual([]);
  }, 120_000);

  it.skipIf(LOSES_A_MESSAGE_ON_WINDOWS)('leaving while two friends on the team are still linking up: the late answer doesn’t put you back on it', async () => {
    net = await crowd();
    const ata = await teamMac(net, 'ata', [{ id: 'pa', name: 'api', repo: 'acme/api' }], withSync);
    const kay = await teamMac(net, 'kay', [{ id: 'pk', name: 'api', repo: 'acme/api' }], withSync);
    const mia = await teamMac(net, 'mia', [{ id: 'pm', name: 'api', repo: 'acme/api' }], withSync);
    macs.push(ata, kay, mia);
    await befriend(ata.person, kay.person);
    await befriend(ata.person, mia.person);
    await teamUp(ata, 'pa', kay, 'pk');
    await teamUp(ata, 'pa', mia, 'pm');
    await settle(() => names(kay, 'pk').length === 2 && names(mia, 'pm').length === 2);

    // Kay's invite and answer to mia are held on the way: kay is linked with her, she isn't yet.
    const held: Array<() => void> = [];
    const send = kay.person.mesh.sendTeam.bind(kay.person.mesh);
    kay.person.mesh.sendTeam = (peerId, payload) => {
      const k = (payload as { m?: { k?: string } }).m?.k;
      if (peerId !== mia.id || (k !== 'invite' && k !== 'accept')) return send(peerId, payload);
      held.push(() => send(peerId, payload));
      return true;
    };
    await befriend(kay.person, mia.person);
    await settle(() => mates(kay, 'pk').find((m) => m.peerId === mia.id)?.indirect === undefined);
    expect(held.length).toBeGreaterThan(0);

    // She leaves, then what kay sent arrives.
    mia.team.leave('pm');
    for (const deliver of held.splice(0)) deliver();
    await settle(() => names(kay, 'pk').length === 1 && names(ata, 'pa').length === 1);
    expect(names(kay, 'pk')).toEqual(['ata']);
    expect(mates(mia, 'pm')).toEqual([]);
  }, 120_000);
});
