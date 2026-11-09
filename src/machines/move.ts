import type { WorktreeCheck } from '../core/worktree-move.js';
import { MOVE_WAIT_MS, MoveAsk, type MoveCaller, type MovePlace, sendOver } from './move-plan.js';

/**
 * Continue On (BLG-808): your app moves a worktree between This Mac and your computers, with its
 * branch and its conversation:
 *
 *   check → (changes not committed: asked, committed only with your yes; its agent at work: its
 *   turn ends first) → its project there (Get Ready if missing) → its branch pushed (or bundled)
 *   and its conversation packed → a worktree there on that branch, the conversation handed to its
 *   agent with your next message, the .env asked about as for any new one → the old one archived.
 *
 * Nothing is dropped: until the new one is there the old one is untouched, and a new one whose
 * old one couldn't be archived is archived again. Browser-safe.
 */

export interface ContinueOnInput {
  readonly from: MoveCaller;
  readonly to: MoveCaller;
  readonly workspaceId: string;
  readonly fromPlace: MovePlace;
  readonly toPlace: MovePlace;
  readonly projectThere: (project: WorktreeCheck['project']) => Promise<string>;
  /** Commit Them and Continue: its changes not committed are committed on its branch first. */
  readonly commit?: boolean;
  /** Wait for its agent's turn to end (else it's asked). */
  readonly wait?: boolean;
  readonly onStep?: (words: string) => void;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const POLL_MS = 3_000;

/** → the new worktree's id there. */
export async function continueOn(input: ContinueOnInput): Promise<string> {
  const { from, to, workspaceId: id, fromPlace, toPlace } = input;
  const say = (words: string): void => input.onStep?.(words);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  say(`Checking it on ${fromPlace.name}…`);
  let check = (await from.call('workspaces.moveCheck', id)) as WorktreeCheck;
  if (check.dirty.length && !input.commit) throw new MoveAsk('dirty', check.dirty, `It has changes not committed (${check.dirty.join(', ')}): commit them on ${check.branch} and continue on ${toPlace.name}?`);
  if (check.busy && !input.wait) throw new MoveAsk('running', ['its agent'], `Its agent is at work: continue on ${toPlace.name} once this turn ends?`);
  const until = Date.now() + (input.waitMs ?? MOVE_WAIT_MS);
  while (check.busy) {
    if (Date.now() > until) throw new Error(`Its agent didn’t finish its turn in time: it stays on ${fromPlace.name}`);
    say('Waiting for its agent to finish its turn…');
    await sleep(input.pollMs ?? POLL_MS);
    check = (await from.call('workspaces.moveCheck', id)) as WorktreeCheck;
  }
  if (check.dirty.length && !input.commit) throw new MoveAsk('dirty', check.dirty, `It has changes not committed (${check.dirty.join(', ')}): commit them on ${check.branch} and continue on ${toPlace.name}?`);
  say(`Finding ${check.project.name} on ${toPlace.name}…`);
  const projectId = await input.projectThere(check.project);
  say(`Sending ${check.branch} and its conversation…`);
  const packed = (await from.call('workspaces.movePack', id, { ...(input.commit ? { commit: true } : {}), to: toPlace.name })) as { token: string; chunks: number };
  await sendOver(from, to, 'workspaces', packed, say, toPlace.name);
  say(`Making the worktree on ${toPlace.name}…`);
  const made = (await to.call('workspaces.moveLand', packed.token, projectId, fromPlace.name)) as string;
  say(`Archiving it on ${fromPlace.name}…`);
  try {
    await from.call('workspaces.moveDone', id, toPlace.name);
  } catch (err) {
    await to.call('workspaces.moveUndo', made).catch(() => undefined);
    throw err;
  }
  return made;
}
