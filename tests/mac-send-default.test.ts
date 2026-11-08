import { describe, expect, it } from 'vitest';
import { answerSend, answeringIn, otherKeyShortcut, otherKeySteers, sendAction, sendsUrgent, steerBlockNote } from '../packages/mac/src/chat/send-action.js';
import { DEFAULT_PREFS } from '../packages/mac/src/lib/prefs.js';
import { runtimeHas } from '../src/shared/runtime-fallbacks.js';

describe('the Mac send action', () => {
  it('steers the running turn when steer is the default', () => {
    expect(sendAction('steer', { busy: true, canSteer: true })).toBe('steer');
  });

  it('keeps queue as the default for existing preferences', () => {
    expect(DEFAULT_PREFS.sendDuringTurn).toBe('queue');
    expect(sendAction(DEFAULT_PREFS.sendDuringTurn, { busy: true, canSteer: true })).toBe('queue');
  });

  it.each([
    ['queue', false, 'queue'],
    ['queue', true, 'steer'],
    ['steer', false, 'steer'],
    ['steer', true, 'queue'],
  ] as const)('with %s as the default and secondary=%s, it chooses %s', (preferred, secondary, expected) => {
    expect(sendAction(preferred, { busy: true, canSteer: true, secondary })).toBe(expected);
  });

  it.each([
    ['queue', false],
    ['queue', true],
    ['steer', false],
    ['steer', true],
  ] as const)('queues when steering is unavailable with default=%s and secondary=%s', (preferred, secondary) => {
    expect(sendAction(preferred, { busy: true, canSteer: false, secondary })).toBe('queue');
  });

  it.each([
    ['queue', false],
    ['queue', true],
    ['steer', false],
    ['steer', true],
  ] as const)('sends normally outside a turn with default=%s and secondary=%s', (preferred, secondary) => {
    expect(sendAction(preferred, { busy: false, canSteer: true, secondary })).toBe('send');
    expect(sendAction(preferred, { busy: false, canSteer: false, secondary })).toBe('send');
  });

  it.each([
    ['queue', false, false],
    ['queue', true, true],
    ['steer', false, true],
    ['steer', true, false],
  ] as const)('during a turn with default=%s and secondary=%s, it goes first in line: %s', (preferred, secondary, expected) => {
    expect(sendsUrgent(preferred, { busy: true, canSteer: true, secondary })).toBe(expected);
    expect(sendsUrgent(preferred, { busy: true, canSteer: false, secondary })).toBe(false);
  });

  it('keeps ⌥↩ first in line outside a turn when Queue is the default, as before the preference', () => {
    expect(sendsUrgent('queue', { busy: false, canSteer: true, secondary: true })).toBe(true);
    expect(sendsUrgent('queue', { busy: false, canSteer: false, secondary: true })).toBe(true);
    expect(sendsUrgent('queue', { busy: false, canSteer: true })).toBe(false);
    expect(sendsUrgent('steer', { busy: false, canSteer: true })).toBe(false);
    expect(sendsUrgent('steer', { busy: false, canSteer: true, secondary: true })).toBe(false);
  });

  it('shows ⌥↩ as a steer key only where it steers', () => {
    expect(otherKeySteers('queue', true)).toBe(true);
    expect(otherKeySteers('steer', true)).toBe(false);
    expect(otherKeySteers('queue', false)).toBe(false);
  });

  it('names ⌥↩ in Settings by what it does with the default', () => {
    expect(otherKeyShortcut('queue').label).toBe('Steer');
    expect(otherKeyShortcut('steer').label).toBe('Queue');
  });

  it('says why a message queues in Plan First or on an agent that cannot steer', () => {
    expect(steerBlockNote('plan')).toMatch(/Plan First/);
    expect(steerBlockNote('agent')).toMatch(/cannot steer/);
  });

  it('queues on OpenCode and permits steering on Claude and Codex', () => {
    expect(runtimeHas('opencode', 'steer')).toBe(false);
    expect(sendAction('steer', { busy: true, canSteer: runtimeHas('opencode', 'steer') })).toBe('queue');
    expect(runtimeHas('claude', 'steer')).toBe(true);
    expect(runtimeHas('codex', 'steer')).toBe(true);
  });
});

describe('the box while a card waits on you', () => {
  const plan = { channel: 'ws:a', question: { kind: 'plan' } };
  const ask = { channel: 'ws:a', question: { kind: 'question' } };

  it('answers the plan or question waiting in this conversation', () => {
    expect(answeringIn([plan], 'ws:a')).toBe('plan');
    expect(answeringIn([ask], 'ws:a')).toBe('question');
  });

  it('is an ordinary box when nothing waits here', () => {
    expect(answeringIn([], 'ws:a')).toBeUndefined();
    expect(answeringIn([plan], 'ws:b')).toBeUndefined();
  });

  it('says it sends changes to the plan, never steer or queue', () => {
    const send = answerSend('plan', 'Claude');
    expect(send.label).toBe('Send Changes');
    expect(send.tip).toContain('revises the plan');
    expect(`${send.label} ${send.tip}`).not.toMatch(/steer|queue/i);
    expect(answerSend('question', 'Claude').label).toBe('Answer');
  });
});
