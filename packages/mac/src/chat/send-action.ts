export type DuringTurnAction = 'queue' | 'steer';

/** Why a message sent now can't steer the running turn: Plan First (the host stops the turn for it), or an agent that can't. */
export type SteerBlock = 'plan' | 'agent';

export interface SendContext {
  readonly busy: boolean;
  readonly canSteer: boolean;
  readonly secondary?: boolean;
}

/** Select the action for the main send control or its per-message override. */
export function sendAction(preferred: DuringTurnAction, { busy, canSteer, secondary = false }: SendContext): 'send' | DuringTurnAction {
  if (!busy) return 'send';
  if (!canSteer) return 'queue';
  return secondary ? (preferred === 'steer' ? 'queue' : 'steer') : preferred;
}

/**
 * Whether a send goes first in line. During a turn: when it steers. Outside one, ⌥↩ with Queue as
 * the default still goes ahead of your messages waiting for a free agent, as it did before the preference.
 */
export function sendsUrgent(preferred: DuringTurnAction, context: SendContext): boolean {
  if (context.busy) return sendAction(preferred, context) === 'steer';
  return context.secondary === true && preferred === 'queue';
}

/** Whether ⌥↩ steers here (so a Steer control may show it as its key). */
export function otherKeySteers(preferred: DuringTurnAction, canSteer: boolean): boolean {
  return sendAction(preferred, { busy: true, canSteer, secondary: true }) === 'steer';
}

/** What the composer says when a message can't steer here. */
export function steerBlockNote(block: SteerBlock): string {
  return block === 'plan' ? 'In Plan First, messages queue.' : 'This agent cannot steer. Messages queue.';
}

/** The ⌥↩ shortcut as Settings › Keyboard names it: the action it does with your default. */
export function otherKeyShortcut(preferred: DuringTurnAction): { readonly label: string; readonly hint: string } {
  return preferred === 'steer'
    ? { label: 'Queue', hint: 'Waits for the current turn to finish. Steer is your default (Settings › General › Writing)' }
    : { label: 'Steer', hint: 'The agent reads it at its next step. Queue is your default (Settings › General › Writing)' };
}
