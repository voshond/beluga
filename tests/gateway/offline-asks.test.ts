import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Crowd, befriend, crowd, settle } from '../mesh/helpers.js';
import { type Node, node, task } from './helpers.js';

/**
 * Asking a friend whose laptop is closed (BLG-705): the request waits for them for the outbox's
 * week, not a day; it says when it reached their Mac; and when it ends here without their answer,
 * the Claude that asked hears so instead of waiting on nothing.
 */

let net: Crowd;
beforeAll(async () => {
  net = await crowd();
}, 30_000);
afterAll(async () => {
  await net?.close();
});

const DAY = 24 * 3600_000;

async function pair(a: string, b: string, clock: () => number): Promise<[Node, Node]> {
  const x = await node(net, a, { now: clock });
  const y = await node(net, b);
  await befriend(x.person, y.person);
  x.trust(y.id, 'trusted');
  y.trust(x.id, 'trusted');
  return [x, y];
}

const tick = (n: Node): void => (n.gw as unknown as { tick(): void }).tick();

async function offline(asker: Node, friend: Node): Promise<void> {
  await friend.stop();
  await settle(() => !asker.person.friend(friend.id)?.online);
}

describe('asking a friend whose Mac is off', () => {
  it('waits more than a day for them, then reaches their Mac and answers', async () => {
    let clock = Date.now();
    const [ivy, jon] = await pair('ivy', 'jon', () => clock);
    await offline(ivy, jon);
    const t = ivy.gw.ask({ person: 'jon', ask: 'what time is it there', by: 'agent', conversation: 'dm:ivy-jon' });
    expect(task(ivy, t.id)?.steps.at(-1)).toContain('offline');
    clock += DAY + 3600_000;
    tick(ivy);
    // Still waiting to go out: no "No word in a day" for a request they never got.
    expect(task(ivy, t.id)?.state).toBe('sent');
    expect(ivy.gw.book.undelivered(t.id)).toBe(true);
    await jon.start();
    await settle(() => task(ivy, t.id)?.state === 'done');
    expect(task(ivy, t.id)?.steps).toContain("Reached jon's Mac");
    expect(ivy.gw.book.undelivered(t.id)).toBe(false);
    await settle(() => ivy.resumes.length === 1);
    expect(ivy.resumes[0]).toMatchObject({ channel: 'dm:ivy-jon' });
    expect(ivy.resumes[0]!.prompt).toContain("jon's agent replied");
  }, 90_000);

  it('a week without them: it fails, nothing is left to go out, and the asking Claude hears it', async () => {
    let clock = Date.now();
    const [kit, lou] = await pair('kit', 'lou', () => clock);
    await offline(kit, lou);
    const t = kit.gw.ask({ person: 'lou', ask: 'send me the slides', by: 'agent', conversation: 'dm:kit-lou' });
    clock += 8 * DAY;
    tick(kit);
    expect(task(kit, t.id)?.state).toBe('failed');
    expect(task(kit, t.id)?.result?.summary).toBe("lou didn't come online in time");
    expect(kit.gw.book.waiting(lou.id)).toHaveLength(0);
    expect(kit.resumes).toHaveLength(1);
    expect(kit.resumes[0]).toMatchObject({ channel: 'dm:kit-lou' });
    expect(kit.resumes[0]!.prompt).toContain('Your request to lou ended without an answer');
    expect(kit.resumes[0]!.prompt).toContain("lou didn't come online in time");
  }, 90_000);

  it('reached them, then a day of silence: it waits a little after this Mac wakes, then fails out loud', async () => {
    let clock = Date.now();
    const [max, nia] = await pair('max', 'nia', () => clock);
    nia.claude.hold();
    const t = max.gw.ask({ person: 'nia', ask: 'a long one', by: 'agent', conversation: 'dm:max-nia' });
    await settle(() => task(max, t.id)?.state === 'working');
    expect(task(max, t.id)?.steps).toContain("Reached nia's Mac");
    await nia.stop();
    // Max's laptop slept for a day: what waited for it gets its chance to arrive first.
    clock += DAY + 3600_000;
    (max.gw as unknown as { lastTickAt: number }).lastTickAt = Date.now() - 5 * 60_000;
    tick(max);
    expect(task(max, t.id)?.state).toBe('working');
    clock += 11 * 60_000;
    tick(max);
    expect(task(max, t.id)?.state).toBe('failed');
    expect(task(max, t.id)?.result?.summary).toBe('No word from nia in a day');
    expect(max.resumes).toHaveLength(1);
    expect(max.resumes[0]!.prompt).toContain('Your request to nia ended without an answer');
    nia.claude.open();
  }, 90_000);
});
