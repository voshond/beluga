import type { SentinelLanding, SentinelMoveCheck } from '../core/sentinel/move.js';
import { MOVE_WAIT_MS, MoveAsk, type MoveCaller, type MovePlace, sendOver } from './move-plan.js';

/**
 * Move To (BLG-807): your app moves a sentinel to another computer of yours, so an always-on
 * computer can watch for you:
 *
 *   check → (pause, wait for its run to end) → its project there (Get Ready if missing) → packed
 *   here → sent over in pieces → landed there, paused, its sources checked with that computer's
 *   variables → gone from here, its tiles with it → on there if it was on and nothing stands in
 *   the way (else it waits paused there, saying why, for you to turn it on).
 *
 * Until the copy is in, the sentinel stays here as it was (on again if Pause and Move paused it);
 * a copy whose original couldn't be taken away goes again. Browser-safe.
 */

export interface MoveSentinelInput {
  readonly from: MoveCaller;
  readonly to: MoveCaller;
  readonly sentinelId: string;
  readonly fromPlace: MovePlace;
  readonly toPlace: MovePlace;
  /** Its project's id there (there already, or got ready there). */
  readonly projectThere: (project: NonNullable<SentinelMoveCheck['project']>) => Promise<string>;
  /** Pause and Move: pause it and wait for its run to end. */
  readonly pause?: boolean;
  readonly onStep?: (words: string) => void;
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SentinelMoved {
  readonly landing: SentinelLanding;
  /** It's on there. */
  readonly on: boolean;
  /** What waits for you there, in words (missing variables, sources that didn't answer, a new webhook address). */
  readonly notes: readonly string[];
}

const POLL_MS = 3_000;

export async function moveSentinel(input: MoveSentinelInput): Promise<SentinelMoved> {
  const { from, to, sentinelId: id, fromPlace, toPlace } = input;
  const say = (words: string): void => input.onStep?.(words);
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  say(`Checking it on ${fromPlace.name}…`);
  let check = (await from.call('sentinel.moveCheck', id)) as SentinelMoveCheck;
  if (check.running && !input.pause) throw new MoveAsk('running', ['its run'], 'It’s running now: pause it and move it once this run ends?');
  const pausedByMove = !check.paused;
  const resumeHere = async (): Promise<void> => {
    if (pausedByMove) await from.call('sentinel.pause', id, false).catch(() => undefined);
  };
  let landing: SentinelLanding;
  try {
    if (pausedByMove) await from.call('sentinel.pause', id, true);
    const until = Date.now() + (input.waitMs ?? MOVE_WAIT_MS);
    while (check.running) {
      if (Date.now() > until) throw new Error(`Its run didn’t end in time: it stays on ${fromPlace.name}`);
      say('Waiting for its run to end…');
      await sleep(input.pollMs ?? POLL_MS);
      check = (await from.call('sentinel.moveCheck', id)) as SentinelMoveCheck;
    }
    let projectId: string | null = null;
    if (check.project) {
      say(`Finding ${check.project.name} on ${toPlace.name}…`);
      projectId = await input.projectThere(check.project);
    }
    say('Packing its steps, runs and numbers…');
    const packed = (await from.call('sentinel.movePack', id)) as { token: string; chunks: number };
    await sendOver(from, to, 'sentinel', packed, say, toPlace.name);
    say(`Checking its sources on ${toPlace.name}…`);
    landing = (await to.call('sentinel.moveLand', packed.token, projectId, fromPlace.name)) as SentinelLanding;
  } catch (err) {
    await resumeHere();
    throw err;
  }
  // The copy is in: only now does it go from here. If it can't, the copy goes again.
  say(`Taking it off ${fromPlace.name}…`);
  try {
    await from.call('sentinel.moveDrop', id);
  } catch (err) {
    await to.call('sentinel.moveDrop', landing.id).catch(() => undefined);
    await resumeHere();
    throw err;
  }
  const notes: string[] = [];
  if (landing.missing.length) notes.push(`It needs ${landing.missing.join(', ')} on ${toPlace.name}: it waits paused there until ${landing.missing.length === 1 ? 'it’s' : 'they’re'} set`);
  else if (!landing.sourcesOk) notes.push(`Its sources didn’t answer on ${toPlace.name}: it waits paused there (its test run says why)`);
  if (landing.webhook) notes.push(`Its webhook has a new address on ${toPlace.name}: paste it where it posts`);
  // It ran before the move and nothing stands in the way: it runs on there (one you'd paused stays paused).
  let on = false;
  if (pausedByMove && !landing.missing.length && landing.sourcesOk) {
    on = await to.call('sentinel.pause', landing.id, false).then(
      () => true,
      () => false,
    );
    if (!on) notes.push(`It’s on ${toPlace.name}, paused: turn it on there`);
  }
  return { landing, on, notes };
}
