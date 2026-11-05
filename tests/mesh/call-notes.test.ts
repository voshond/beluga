import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallNotes } from '../../src/core/calls/notes.js';
import { callNotesTools } from '../../src/core/calls/notes-tools.js';
import { CallService, meshLinks } from '../../src/core/calls/service.js';
import type { CallNotesView } from '../../src/shared/calls.js';
import { groupConversation } from '../../src/net/mesh/views.js';
import { type Crowd, type Person, befriend, crowd, settle } from './helpers.js';

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

/** Someone's Mac in a call, keeping notes (on disk, as the daemon does). */
function mac(p: Person): { calls: CallService; notes: CallNotes; seen: () => Readonly<Record<string, readonly CallNotesView[]>> } {
  let view: Readonly<Record<string, readonly CallNotesView[]>> = {};
  const notes = new CallNotes({ dir: mkdtempSync(path.join(os.tmpdir(), 'beluga-notes-')), isMe: (id) => id === p.mesh.peerId, nameOf: (id) => p.mesh.nameFor(id), publish: (v) => (view = v) });
  const calls = new CallService({ links: meshLinks(p.mesh), manual: true, publish: () => undefined, signal: () => undefined, ring: () => undefined, toast: () => undefined, client: () => 'mac-1', notes: (from, call, phrases) => notes.theirs(from, call, phrases) });
  return { calls, notes, seen: () => view };
}

describe('call notes (BLG-715)', () => {
  it('each Mac sends its own words to the others who were in the call; everyone gets one merged transcript', async () => {
    const ann = await net.add('ann');
    const bo = await net.add('bo');
    const cy = await net.add('cy');
    await befriend(ann, bo);
    await befriend(ann, cy);
    await befriend(bo, cy);
    const group = ann.mesh.createGroup('standup', [bo.identity.peerId, cy.identity.peerId]);
    await settle(() => bo.group(group.id)?.active && cy.group(group.id)?.active);
    const conv = groupConversation(group.id);
    const a = mac(ann);
    const b = mac(bo);
    const c = mac(cy);
    const call = a.calls.start(conv);
    await settle(() => b.calls.list()[conv]);
    b.calls.join(conv);
    await settle(() => a.calls.list()[conv]?.people.length === 2);
    const t = call.startedAt;
    // ann and bo were in it; cy never joined.
    a.notes.mine(ann.mesh.peerId, a.calls.pastCall(call.id)!, [{ at: t + 2_000, text: 'Shall we ship today?' }]);
    expect(a.calls.sendNotes(call.id, [{ at: t + 2_000, text: 'Shall we ship today?' }])).toBe(1);
    b.notes.mine(bo.mesh.peerId, b.calls.pastCall(call.id)!, [{ at: t + 5_000, text: 'Yes, after the tax fix.' }]);
    b.calls.sendNotes(call.id, [{ at: t + 5_000, text: 'Yes, after the tax fix.' }]);
    await settle(() => a.seen()[conv]?.[0]?.lines.length === 2 && b.seen()[conv]?.[0]?.lines.length === 2);
    expect(a.seen()[conv]![0]!.lines.map((l) => [l.name, l.text])).toEqual([
      ['You', 'Shall we ship today?'],
      ['bo', 'Yes, after the tax fix.'],
    ]);
    expect(callNotesTools({ views: () => a.notes.views(), placeOf: () => '#standup' }).read(call.id)).toMatch(/\[0:05\] bo: Yes, after the tax fix\./);
    // cy wasn't in the call: nothing was sent to them, and notes they're sent anyway are refused.
    expect(c.seen()[conv]).toBeUndefined();
    c.calls.receive(ann.identity.peerId, { k: 'notes', call: call.id, g: group.id, startedAt: t, phrases: [{ at: t, text: 'sneaky' }] });
    expect(c.seen()[conv]).toBeUndefined();
    a.notes.forget(call.id);
    expect(a.seen()[conv]).toBeUndefined();
    for (const x of [a, b, c]) x.calls.stop();
  }, 60_000);
});
