import { busyChannels } from '../core/board/work.js';
import { initiativeChatChannel } from '../core/initiatives/model.js';
import { needInitiatives } from '../core/initiatives/registry.js';
import type { Session } from '../core/session.js';
import type { Args, Method } from './api.js';

type InitiativesMethod = Extract<Method, `initiatives.${string}`>;
type Answer = object | void;
type InitiativesHandlers = { readonly [M in InitiativesMethod]: (s: Session, ...args: Args<M>) => Answer | Promise<Answer> };

export const INITIATIVES_HANDLERS = {
  'initiatives.create': (s, draft) => needInitiatives(s).create(draft),
  'initiatives.update': (s, slug, patch) => needInitiatives(s).update(slug, patch),
  'initiatives.archive': (s, slug) => needInitiatives(s).archive(slug),
  'initiatives.setRepo': (s, slug, repo, linked) => needInitiatives(s).setRepo(slug, repo, linked),
  'initiatives.setCheckIn': (s, slug, on) => needInitiatives(s).setCheckIn(slug, on),
  'initiatives.checkInNow': (s, slug) => needInitiatives(s).checkInNow(slug),
  'initiatives.refreshTickets': (s, slug) => needInitiatives(s).refreshTickets(slug),
  'initiatives.refineGoal': (s, input) => needInitiatives(s).refineGoal(input),
  'initiatives.chatNew': (s, slug) => needInitiatives(s).chatNew(slug),
  'initiatives.chatOpen': (s, slug, id) => needInitiatives(s).chatOpen(slug, id),
  'initiatives.chatDelete': async (s, slug, id) => {
    const channel = initiativeChatChannel(slug, id);
    if (busyChannels(s.store.getState().log).has(channel)) s.host.stopRun(channel);
    s.host.forgetContext(channel);
    await needInitiatives(s).chatDelete(slug, id);
  },
  'initiatives.resolveSuggestion': (s, slug, id, decision, answer) => needInitiatives(s).resolveSuggestion(slug, id, decision, answer),
  'initiatives.sendDraft': (s, slug, id, text) => needInitiatives(s).sendDraft(slug, id, text),
  'initiatives.discardDraft': (s, slug, id) => needInitiatives(s).discardDraft(slug, id),
  'initiatives.readFile': (s, slug, rel) => needInitiatives(s).readFile(slug, rel),
} satisfies InitiativesHandlers;
