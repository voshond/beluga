import type { MoveCheck } from '../core/plans/move.js';
import type { Plan } from '../core/plans/model.js';

/**
 * Move To (BLG-806): your app moves a plan from the computer it runs on to another one of yours
 * (This Mac included), between milestones, through each computer's daemon:
 *
 *   check → (pause, wait for its agents to finish their turn) → its project there (Get Ready if
 *   missing) → packed here → sent over in pieces → landed there, paused → this copy becomes its
 *   record → resumed there (if it ran).
 *
 * Nothing is dropped if it fails halfway: until the copy is in, the plan stays where it was (and
 * runs again if Pause and Move paused it); a copy whose old one couldn't be put away is taken back
 * off. Browser-safe: the Mac app runs it with each computer's client, tests with fakes.
 */

/** A computer's daemon as the move talks to it (a SocketClient). */
export interface MoveCaller {
  call(method: string, ...args: unknown[]): Promise<unknown>;
}

/** A computer in the move: its device id (none: the app's own Mac) and its name. */
export interface MovePlace {
  readonly id?: string;
  readonly name: string;
}

export type MoveStep = 'checking' | 'pausing' | 'waiting' | 'getting-ready' | 'packing' | 'sending' | 'landing' | 'finishing';

export interface MovePlanInput {
  readonly from: MoveCaller;
  readonly to: MoveCaller;
  readonly planId: string;
  readonly fromPlace: MovePlace;
  readonly toPlace: MovePlace;
  /** The project's id there: there already, or got ready there (each step shown by the caller). */
  readonly projectThere: (project: MoveCheck['project']) => Promise<string>;
  /** Pause and Move: pause it and wait for what's at work to finish its turn. */
  readonly pause?: boolean;
  /** Commit Them and Move: changes not committed in its worktrees are committed first. */
  readonly commit?: boolean;
  readonly onStep?: (step: MoveStep, words: string) => void;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** It can't move as asked: what to ask you first (Pause and Move, Commit Them and Move), in words. */
export class MoveAsk extends Error {
  constructor(
    readonly kind: 'running' | 'dirty',
    readonly items: readonly string[],
    message: string,
  ) {
    super(message);
  }
}

export interface Moved {
  /** The plan's id there (the same id). */
  readonly planId: string;
  /** It's there but couldn't be resumed: said in words. */
  readonly warning?: string;
}

/** Waiting for its agents to finish their turn, at most this long. */
export const MOVE_WAIT_MS = 20 * 60_000;
const POLL_MS = 3_000;

const list = (items: readonly string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : (items[0] ?? ''));
const upFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** What Move To asks before it moves (none: it can go now). */
export function moveQuestion(check: MoveCheck, opts: { readonly pause?: boolean; readonly commit?: boolean }): MoveAsk | undefined {
  if (check.running.length && !opts.pause) return new MoveAsk('running', check.running, `${upFirst(list(check.running))} ${check.running.length === 1 ? 'is' : 'are'} at work: pause the plan and move it once ${check.running.length === 1 ? 'it finishes its' : 'they finish their'} turn?`);
  if (check.dirty.length && !opts.commit) return new MoveAsk('dirty', check.dirty, `${upFirst(list(check.dirty))} ${check.dirty.length === 1 ? 'has' : 'have'} changes not committed: commit them on the branch and move it?`);
  return undefined;
}

/** A packed package from one computer to the other, a piece at a time (`api`: plans, sentinel or workspaces). */
export async function sendOver(from: MoveCaller, to: MoveCaller, api: 'plans' | 'sentinel' | 'workspaces', packed: { readonly token: string; readonly chunks: number }, say: (words: string) => void, toName: string): Promise<void> {
  for (let n = 0; n < packed.chunks; n++) {
    say(packed.chunks > 1 ? `Sending it to ${toName} (${n + 1} of ${packed.chunks})…` : `Sending it to ${toName}…`);
    const data = (await from.call(`${api}.moveChunk`, packed.token, n)) as string;
    await to.call(`${api}.moveReceive`, packed.token, n, packed.chunks, data);
  }
}

export async function movePlan(input: MovePlanInput): Promise<Moved> {
  const { from, to, planId, fromPlace, toPlace } = input;
  const step = (s: MoveStep, words: string): void => input.onStep?.(s, words);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = input.now ?? Date.now;
  step('checking', `Checking the plan on ${fromPlace.name}…`);
  let check = (await from.call('plans.moveCheck', planId)) as MoveCheck;
  if (check.blocked) throw new Error(check.blocked);
  const ask = moveQuestion(check, input);
  if (ask) throw ask;

  // From here it's paused, so nothing new starts while it moves; a move that doesn't finish resumes it.
  const pausedByMove = !check.paused;
  const resumeHere = async (): Promise<void> => {
    if (pausedByMove) await from.call('plans.setPaused', planId, false).catch(() => undefined);
  };
  let landed: Plan;
  try {
    if (pausedByMove) {
      step('pausing', 'Pausing the plan…');
      await from.call('plans.setPaused', planId, true);
    }
    const until = now() + (input.waitMs ?? MOVE_WAIT_MS);
    while (check.running.length) {
      if (now() > until) throw new Error(`${upFirst(list(check.running))} didn’t finish in time: the plan stays on ${fromPlace.name}`);
      step('waiting', `Waiting for ${list(check.running)} to finish ${check.running.length === 1 ? 'its' : 'their'} turn…`);
      await sleep(input.pollMs ?? POLL_MS);
      check = (await from.call('plans.moveCheck', planId)) as MoveCheck;
      if (check.blocked) throw new Error(check.blocked);
    }
    if (check.dirty.length && !input.commit) throw moveQuestion(check, { pause: true })!;
    step('getting-ready', `Finding ${check.project.name} on ${toPlace.name}…`);
    const projectId = await input.projectThere(check.project);
    step('packing', 'Packing the plan, its tasks and its branches…');
    const packed = (await from.call('plans.movePack', planId, { ...(input.commit ? { commit: true } : {}), to: toPlace.name })) as { token: string; chunks: number };
    await sendOver(from, to, 'plans', packed, (words) => step('sending', words), toPlace.name);
    step('landing', `Setting it up on ${toPlace.name}…`);
    landed = (await to.call('plans.moveLand', packed.token, projectId, { ...(fromPlace.id ? { id: fromPlace.id } : {}), name: fromPlace.name, at: now() })) as Plan;
  } catch (err) {
    await resumeHere();
    throw err;
  }

  // The copy is in: only now does the old one become its record. If it can't, the copy goes again.
  step('finishing', `Putting the old copy away on ${fromPlace.name}…`);
  try {
    await from.call('plans.moveDone', planId, { ...(toPlace.id ? { id: toPlace.id } : {}), name: toPlace.name, at: now(), planId: landed.id });
  } catch (err) {
    await to.call('plans.moveUndo', landed.id).catch(() => undefined);
    await resumeHere();
    throw err;
  }
  // It ran before the move: it runs on there (one you'd paused stays paused).
  if (pausedByMove) {
    const resumed = await to.call('plans.setPaused', landed.id, false).then(
      () => true,
      () => false,
    );
    if (!resumed) return { planId: landed.id, warning: `It’s on ${toPlace.name}, paused: resume it there` };
  }
  return { planId: landed.id };
}
