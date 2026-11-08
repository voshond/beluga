import { randomUUID } from 'node:crypto';
import type { BodyInput, BodyOf, ClaudeAnswer, ClaudeQuestion } from '../protocol.js';
import { type Store, clean } from './store.js';

export interface QuestionDeps {
  readonly store: Store;
  readonly selfId: () => string;
  readonly send: (body: BodyInput, opts: { to: string }) => boolean;
  /** How long Claude waits for an answer before carrying on without one. */
  readonly timeoutMs: () => number;
  readonly toast: (text: string, level?: 'info' | 'warn') => void;
}

const SKIP: ClaudeAnswer = { kind: 'skip' };

/** Peer-supplied text never carries terminal control sequences onto your screen. */
export function cleanQuestion(q: ClaudeQuestion): ClaudeQuestion {
  if (q.kind === 'plan') return { kind: 'plan', plan: clean(q.plan) };
  return {
    kind: 'question',
    questions: q.questions.map((x) => ({ ...x, question: clean(x.question), header: clean(x.header), options: x.options.map((o) => ({ label: clean(o.label), description: clean(o.description) })) })),
  };
}

const MAX_WAITING = 20;

/**
 * Claude's questions and plans go to the person who asked Claude, wherever they are:
 * a card on your own screen, or a message to a friend whose request it is. Answers
 * are only accepted from that person, and nobody waits forever.
 */
export class QuestionBroker {
  private readonly waiting = new Map<string, { peer: string; channel: string; resolve: (a: ClaudeAnswer) => void; timer: NodeJS.Timeout }>();
  /** Requests you sent → whose Claude got them, so only that Claude can ask you things. */
  private readonly mine = new Map<string, { target: string; channel: string }>();
  /** Cards Beluga itself put on your screen (a plan task that's yours to decide): no timeout, answered here. */
  private readonly posed = new Map<string, (a: ClaudeAnswer) => void>();

  constructor(private readonly deps: QuestionDeps) {}

  /**
   * Put a card on your own screen that Beluga answers itself (not Claude): a plan's decision for
   * you. It waits until you answer it or it's withdrawn; asking again with the same qid only
   * replaces what to do with the answer.
   */
  pose(qid: string, channel: string, question: ClaudeQuestion, onAnswer: (a: ClaudeAnswer) => void): void {
    this.posed.set(qid, onAnswer);
    if (this.deps.store.getState().questions.some((q) => q.qid === qid)) return;
    const self = this.deps.selfId();
    this.deps.store.dispatch({ type: 'question_add', question: { qid, requestId: qid, owner: self, channel, question, picked: {} } });
  }

  /** Take back a card `pose` put up (it isn't needed any more). */
  withdraw(qid: string): void {
    if (!this.posed.delete(qid)) return;
    if (this.deps.store.getState().questions.some((q) => q.qid === qid)) this.deps.store.dispatch({ type: 'question_remove', qid });
  }

  /** Whether a card `pose` put up is still waiting. */
  posing(qid: string): boolean {
    return this.posed.has(qid);
  }

  /** Remember a request you sent (to your own or a friend's Claude). */
  track(requestId: string, target: string, channel: string): void {
    this.mine.set(requestId, { target, channel });
    if (this.mine.size > 500) this.mine.delete(this.mine.keys().next().value as string);
  }

  /** On the computer running Claude: ask `requester` and wait for their answer. */
  ask(requester: string, requestId: string, channel: string, question: ClaudeQuestion): Promise<ClaudeAnswer> {
    if (this.waiting.size >= MAX_WAITING) return Promise.resolve(SKIP);
    const qid = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.waiting.delete(qid)) return;
        this.deps.store.dispatch({ type: 'question_remove', qid });
        this.deps.toast(`Your agent's ${question.kind === 'plan' ? 'plan' : 'question'} went unanswered, so it carried on without it`, 'warn');
        resolve(SKIP);
      }, this.deps.timeoutMs());
      timer.unref();
      this.waiting.set(qid, { peer: requester, channel, resolve, timer });
      if (requester === this.deps.selfId()) {
        this.deps.store.dispatch({ type: 'question_add', question: { qid, requestId, owner: requester, channel, question, picked: {} } });
      } else if (!this.deps.send({ kind: 'agent_question', requestId, qid, channel, question }, { to: requester })) {
        this.settle(qid, requester, SKIP);
      }
    });
  }

  /** A friend's Claude, working on your request, asks you something. */
  onQuestion(from: string, body: BodyOf<'agent_question'>): void {
    const sent = this.mine.get(body.requestId);
    if (!sent || sent.target !== from || sent.channel !== body.channel) return;
    this.deps.store.dispatch({ type: 'question_add', question: { qid: body.qid, requestId: body.requestId, owner: from, channel: body.channel, question: cleanQuestion(body.question), picked: {} } });
  }

  /** Someone left: stop waiting on questions only they could answer. */
  cancelFor(peerId: string): void {
    for (const [qid, w] of [...this.waiting]) if (w.peer === peerId) this.settle(qid, peerId, SKIP);
  }

  /** The person you asked answered. */
  onAnswer(from: string, body: BodyOf<'agent_answer'>): void {
    this.settle(body.qid, from, body.answer);
  }

  /** You answered a card on your screen. */
  answer(qid: string, answer: ClaudeAnswer): void {
    const q = this.deps.store.getState().questions.find((x) => x.qid === qid);
    if (!q) return;
    const posed = this.posed.get(qid);
    if (posed) {
      // Skipping one of Beluga's own cards leaves it waiting: it's yours to answer.
      if (answer.kind === 'skip') return;
      this.posed.delete(qid);
      this.deps.store.dispatch({ type: 'question_remove', qid });
      return posed(answer);
    }
    this.deps.store.dispatch({ type: 'question_remove', qid });
    // Approving Claude's plan ends planning in that conversation: what you send next is acted on.
    if (answer.kind === 'plan' && answer.approve && this.deps.store.getState().planMode[q.channel]) this.deps.store.dispatch({ type: 'plan_mode', channel: q.channel, on: false });
    const self = this.deps.selfId();
    if (q.owner === self) this.settle(qid, self, answer);
    else this.deps.send({ kind: 'agent_answer', qid, answer }, { to: q.owner });
  }

  answerPart(qid: string, question: string, text: string): void {
    const q = this.deps.store.getState().questions.find((x) => x.qid === qid);
    if (!q || q.question.kind !== 'question') return;
    const picked = { ...q.picked, [question]: text };
    this.deps.store.dispatch({ type: 'question_pick', qid, question, answer: text });
    if (!q.question.questions.every((x) => picked[x.question] !== undefined)) return;
    const answers = Object.fromEntries(Object.entries(picked).filter(([k]) => !k.endsWith('#multi')));
    this.answer(qid, { kind: 'answers', answers });
  }

  /** Stop waiting on everything (e.g. Claude was stopped). */
  cancelAll(): void {
    for (const [qid, w] of [...this.waiting]) this.settle(qid, w.peer, SKIP);
  }

  /** Stop waiting on Claude's questions in one conversation (you stopped Claude there). */
  cancelChannel(channel: string): void {
    for (const [qid, w] of [...this.waiting]) if (w.channel === channel) this.settle(qid, w.peer, SKIP);
  }

  private settle(qid: string, from: string, answer: ClaudeAnswer): void {
    const w = this.waiting.get(qid);
    if (!w || w.peer !== from) return;
    clearTimeout(w.timer);
    this.waiting.delete(qid);
    this.deps.store.dispatch({ type: 'question_remove', qid });
    w.resolve(answer);
  }
}
