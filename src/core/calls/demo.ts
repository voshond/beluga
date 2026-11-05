import type { Mesh } from '../../net/mesh/mesh.js';
import { CallService, meshLinks } from './service.js';

/**
 * The demo's friends in calls (BLG-706): bob and mia are real Macs on the demo's network, so a
 * call to them rings theirs and they answer like anyone would, after a moment. They make no sound
 * (no window): the Mac app's demo plays their side (call/demo-media.ts).
 */

export interface DemoCallers {
  /** Someone rings you in a conversation they share with you (the call scene). */
  ring(who: Mesh, conversation: string): void;
  /** Someone turns their camera on or shares (they make no picture: the window plays it). */
  set(who: Mesh, conversation: string, change: { readonly camera?: boolean; readonly sharing?: boolean }): void;
  stop(): void;
}

/** What each friend says in a call (their notes, as their Mac would have written them down), seconds in. */
const SAID: Record<string, ReadonlyArray<readonly [number, string]>> = {
  bob: [
    [3, 'Hey, can you hear me okay?'],
    [14, 'So the checkout total is off when someone uses a discount code.'],
    [27, 'I think tax runs after the discount. It should be the other way round.'],
    [52, 'Let’s ship the fix today and add a test for expired codes.'],
    [96, 'One more thing: the receipt email still shows the old total, before the discount.'],
    [131, 'I can take the email. It reads the order before it’s saved, that’s the bug.'],
    [205, 'For the test, let’s use the spring code and a cart with two regions.'],
    [262, 'Do we tell support? A few people were charged a little more than they should have been.'],
    [330, 'Refunds are fine by me. It’s under fifty orders.'],
    [402, 'Okay, I’ll write up the plan in the channel after this.'],
    [455, 'Thanks both, talk tomorrow.'],
  ],
  mia: [
    [6, 'Hi both, sound’s good here.'],
    [20, 'I saw the same thing on staging yesterday, with the spring code.'],
    [44, 'I’ll update the landing copy once the fix is in.'],
    [110, 'The receipt template is mine, I can check it with Bob.'],
    [168, 'Should the discount line show before or after tax on the receipt?'],
    [280, 'Yes, I’ll draft a note to support and the affected customers.'],
    [355, 'I’ll pull the list of orders from Stripe this afternoon.'],
    [440, 'Sounds good, bye!'],
  ],
};

/** What each friend writes in the chat while you share your screen (seconds after you start). */
const WHILE_YOU_SHARE: Record<string, readonly [number, string]> = {
  bob: [3, 'Can you scroll down to the totals?'],
  mia: [7, 'There, the discount line sits above tax. That’s the bug.'],
};

/** How long each friend takes to pick up. */
const PICKUP_MS: Record<string, number> = { bob: 1_800, mia: 3_200 };

export function demoCallers(friends: readonly Mesh[], pace = 1): DemoCallers {
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void): void => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms * pace);
    t.unref();
    timers.add(t);
  };
  const services = new Map<Mesh, CallService>();
  const ids = new Set(friends.map((m) => m.peerId));
  for (const mesh of friends) {
    const answered = new Set<string>();
    const metYou = new Set<string>();
    const leaving = new Set<string>();
    const sawShare = new Set<string>();
    const calls: CallService = new CallService({
      links: meshLinks(mesh),
      headless: true,
      publish: (view) => {
        for (const call of Object.values(view)) {
          // You left (only the demo's friends are still in it): they leave too, and send their notes.
          if (call.mine === 'in') {
            const others = call.people.filter((p) => !p.me);
            if (others.some((p) => !ids.has(p.peerId))) metYou.add(call.id);
            else if (metYou.has(call.id) && !leaving.has(call.id)) {
              leaving.add(call.id);
              const name = mesh.summary().self?.name ?? '';
              later(PICKUP_MS[name] ?? 1_500, () => {
                const said = (SAID[name] ?? []).map(([s, text]) => ({ at: call.startedAt + s * 1000, text }));
                try {
                  calls.sendNotes(call.id, said);
                } catch {
                  // Not a call they were in.
                }
                calls.leave(call.conversation);
              });
            }
            // You share your screen: they write about it in the chat, as people do.
            const line = WHILE_YOU_SHARE[mesh.summary().self?.name ?? ''];
            if (line && !sawShare.has(call.id) && others.some((p) => !ids.has(p.peerId) && p.sharing)) {
              sawShare.add(call.id);
              later(line[0] * 1000, () => {
                try {
                  mesh.post(call.conversation, line[1]);
                } catch {
                  // Not in that conversation any more.
                }
              });
            }
          }
          if (call.mine !== 'ringing' || answered.has(call.id)) continue;
          answered.add(call.id);
          later(PICKUP_MS[mesh.summary().self?.name ?? ''] ?? 2_400, () => {
            try {
              calls.join(call.conversation);
            } catch {
              // It ended before they picked up.
              return;
            }
            // bob likes his camera on; it comes on a moment after he picks up.
            if (mesh.summary().self?.name === 'bob') later(1_500, () => calls.set(call.conversation, { camera: true }));
          });
        }
      },
      signal: () => undefined,
      ring: () => undefined,
      toast: () => undefined,
      client: () => undefined,
    });
    services.set(mesh, calls);
  }
  return {
    ring: (who, conversation) => services.get(who)?.start(conversation),
    set: (who, conversation, change) => {
      try {
        services.get(who)?.set(conversation, change);
      } catch {
        // Not in that call any more.
      }
    },
    stop: () => {
      for (const t of timers) clearTimeout(t);
      for (const s of services.values()) s.stop();
    },
  };
}
