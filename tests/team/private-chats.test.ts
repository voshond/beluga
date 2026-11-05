import { afterEach, describe, expect, it } from 'vitest';
import { createDemoWorkspaces } from '../../src/demo.js';
import { TeamBoardSync } from '../../src/core/team/board-sync.js';
import { teamShareChoices } from '../../src/core/team/model.js';
import { TeamMsg } from '../../src/core/team/protocol.js';
import { TeamBoards } from '../../src/core/team/service.js';
import { Board } from '../../src/core/board/board.js';
import type { Project } from '../../src/workspaces/types.js';
import { type Crowd, SLOW, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Mac, mac } from '../friend-share/helpers.js';

/** BLG-226: teaming up never shares a conversation; one is shared on purpose, live, and can be stopped. */

let net: Crowd | undefined;
const macs: Mac[] = [];
const teams: TeamBoards[] = [];

afterEach(async () => {
  for (const t of teams.splice(0)) t.stop();
  for (const m of macs.splice(0)) await m.close();
  await net?.close();
  net = undefined;
});

/** Team boards on a sharing Mac: every project there is on github.com/acme/<its name>. */
async function withTeam(m: Mac): Promise<TeamBoards> {
  const board = new Board({ store: m.store, dir: null, projectName: (id) => m.store.getState().projects.find((p) => p.id === id)?.name });
  const team = new TeamBoards({ store: m.store, mesh: m.person.mesh, dir: m.person.dir, repoOf: async (id) => {
    const name = m.store.getState().projects.find((p) => p.id === id)?.name;
    return name ? { host: 'github.com', owner: 'acme', repo: name, url: `https://github.com/acme/${name}` } : undefined;
  } });
  team.use(new TeamBoardSync(team, { board, live: () => true, dir: null }));
  await team.start();
  teams.push(team);
  return team;
}

describe('conversations in a team', () => {
  it('stay private when teaming up; Share with Team shares one worktree live, and Stop Sharing ends it', async () => {
    net = await crowd();
    const ata = await mac(net, 'ata', { workspaces: await createDemoWorkspaces() });
    const kay = await mac(net, 'kay');
    macs.push(ata, kay);
    // Kay has the same repository as a project of their own (no worktrees shared).
    kay.store.dispatch({ type: 'projects', projects: [{ id: 'k-bob', name: 'bob-api', root: '/tmp/kay/bob-api', base: 'origin/main', workspaces: [] } as unknown as Project] });
    const ta = await withTeam(ata);
    const tk = await withTeam(kay);
    await befriend(ata.person, kay.person);
    const project = ata.store.getState().projects.find((p) => p.name === 'bob-api')!;
    await settle(() => ata.store.getState().team.offers.find((o) => o.projectId === project.id) && kay.store.getState().team.offers[0]);
    ta.answer(kay.id, project.id, true);
    await settle(() => kay.store.getState().team.offers[0]?.state === 'invited');
    tk.answer(ata.id, 'k-bob', true);
    await settle(() => ata.store.getState().team.teams[project.id] && kay.store.getState().team.teams['k-bob']);

    // A team, and still nothing of ata's conversations on kay's Mac.
    const ws = project.workspaces.find((w) => !w.archived && !w.external && w.kind !== 'main')!;
    ata.session.sendChat('private thought', false, `ws:${ws.id}`);
    await new Promise((r) => setTimeout(r, 400));
    expect(kay.store.getState().shared).toEqual([]);
    expect(kay.store.getState().sharedProjects).toEqual([]);
    expect(kay.store.getState().log.some((l) => 'text' in l && String(l.text).includes('private thought'))).toBe(false);
    // Nothing a team frame can carry is a chat (a knock's note is a few words asking in, BLG-416; the chat comes only once they're let in; a roster is names and a befriend a friend invitation, BLG-510).
    expect(TeamMsg.options.map((o) => o.shape.k.value).sort()).toEqual(['accept', 'befriend', 'context', 'decline', 'digest', 'invite', 'knock', 'knock_answer', 'knock_cancel', 'leave', 'ops', 'plan', 'plan_gone', 'repos', 'review', 'roster']);
    expect(teamShareChoices(ata.store.getState().team, ata.store.getState().members[ws.id], project.id)).toMatchObject({ mates: [{ peerId: kay.id, shared: false }], sharedWith: [] });

    // Share with Team › kay: that one worktree, live, and the conversation shows who can see it.
    ata.session.sharing.shareWithFriend({ peerId: kay.id, workspaceId: ws.id, role: 'contribute' });
    await settle(() => kay.store.getState().shared.some((w) => w.id === ws.id));
    expect(kay.store.getState().shared.map((w) => w.id)).toEqual([ws.id]);
    expect(teamShareChoices(ata.store.getState().team, ata.store.getState().members[ws.id], project.id).sharedWith).toEqual([kay.id]);
    ata.session.sendChat('now we both see this', false, `ws:${ws.id}`);
    await settle(() => kay.store.getState().log.some((l) => l.type === 'chat' && l.channel === `ws:${ws.id}` && l.text === 'now we both see this'));

    // Stop Sharing.
    ata.session.sharing.unshareFriend({ peerId: kay.id, workspaceId: ws.id });
    await settle(() => !kay.store.getState().shared.some((w) => w.id === ws.id));
    expect(teamShareChoices(ata.store.getState().team, ata.store.getState().members[ws.id], project.id).sharedWith).toEqual([]);
  }, 60_000 * SLOW);
});
