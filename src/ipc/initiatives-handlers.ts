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
  'initiatives.setCheckInTime': (s, slug, schedule) => needInitiatives(s).setCheckInTime(slug, schedule),
  'initiatives.checkInNow': (s, slug) => needInitiatives(s).checkInNow(slug),
  'initiatives.refreshTickets': (s, slug) => needInitiatives(s).refreshTickets(slug),
  'initiatives.refreshTasks': (s, slug) => needInitiatives(s).refreshTasks(slug),
  'initiatives.setTaskDone': (s, slug, id, done) => needInitiatives(s).setTaskDone(slug, id, done),
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
  'initiatives.clarifySuggestion': (s, slug, id) => needInitiatives(s).clarifySuggestion(slug, id),
  'initiatives.sendDraft': (s, slug, id, text) => needInitiatives(s).sendDraft(slug, id, text),
  'initiatives.discardDraft': (s, slug, id) => needInitiatives(s).discardDraft(slug, id),
  'initiatives.readFile': (s, slug, rel) => needInitiatives(s).readFile(slug, rel),
  'initiatives.readArtifact': (s, slug, id) => needInitiatives(s).readArtifact(slug, id),
  'initiatives.savePerson': (s, draft) => needInitiatives(s).savePerson(draft),
  'initiatives.removePerson': (s, person) => needInitiatives(s).removePerson(person),
  'initiatives.setPerson': (s, slug, person, role) => needInitiatives(s).setPerson(slug, person, role ?? null),
  'initiatives.proposePeople': (s, slug) => needInitiatives(s).proposePeople(slug),
  'initiatives.enrichPeople': (s, only) => needInitiatives(s).enrichPeople(only),
  'initiatives.keepEnrichment': (s, person, field) => needInitiatives(s).keepEnrichment(person, field),
  'initiatives.dropEnrichment': (s, person, field) => needInitiatives(s).dropEnrichment(person, field),
  'initiatives.personAvatar': (s, sha) => needInitiatives(s).personAvatar(sha),
  'initiatives.saveAudience': (s, slug, draft) => needInitiatives(s).saveAudience(slug, draft),
  'initiatives.removeAudience': (s, slug, id) => needInitiatives(s).removeAudience(slug, id),
  'initiatives.draftUpdate': (s, slug, id) => needInitiatives(s).draftUpdate(slug, id),
  'initiatives.keepPrep': (s, slug, id, text) => needInitiatives(s).keepPrep(slug, id, text),
  'initiatives.saveQuestion': (s, slug, draft) => needInitiatives(s).saveQuestion(slug, draft),
  'initiatives.draftQuestion': (s, slug, id) => needInitiatives(s).draftQuestion(slug, id),
  'initiatives.removeQuestion': (s, slug, id) => needInitiatives(s).removeQuestion(slug, id),
  'initiatives.addWatch': (s, slug, draft) => needInitiatives(s).addWatch(slug, draft),
  'initiatives.stopWatch': (s, slug, id) => needInitiatives(s).stopWatch(slug, id),
  'initiatives.lookNow': (s, slug, id) => needInitiatives(s).lookNow(slug, id),
  'initiatives.readNews': (s, slug, id) => needInitiatives(s).readNews(slug, id),
  'initiatives.saveRisk': (s, slug, draft) => needInitiatives(s).saveRisk(slug, draft),
  'initiatives.defineSuccess': (s, slug) => needInitiatives(s).defineSuccess(slug),
  'initiatives.acceptSuccess': (s, slug, proposal) => needInitiatives(s).acceptSuccess(slug, proposal),
  'initiatives.discoveryStep': (s, slug, step) => needInitiatives(s).discoveryStep(slug, step),
  'initiatives.promote': (s, slug) => needInitiatives(s).promote(slug),
} satisfies InitiativesHandlers;
