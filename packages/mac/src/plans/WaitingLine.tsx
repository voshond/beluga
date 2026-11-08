import { type WaitingMessage, waitingWords } from '@beluga/core/plans/watchdog.js';
import { Tip } from '../components/ui.js';
import { toast, useApi, useBeluga } from '../lib/beluga.js';
import p from './plans.module.css';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const snippet = (prompt: string): string => prompt.replace(/\s+/g, ' ').slice(0, 160) || 'A message';

/**
 * A queued message's two ways in: Send Now (next, never interrupting: into the running turn at
 * Claude's next step, else first in line) and Steer Now (the chat's Steer: a long command or a
 * stuck turn is interrupted, a dead run restarted).
 */
function SendOrSteer({ requestId }: { requestId: string }) {
  const api = useApi();
  const { client } = useBeluga();
  const run = (call: Promise<unknown>): void => void call.catch((err: unknown) => toast(client, errorText(err), 'error'));
  return (
    <>
      <span aria-hidden="true">·</span>
      <Tip label="Your agent reads it next, without stopping what it's doing">
        <button
          type="button"
          className={p.steerNow}
          onClick={(e) => {
            e.stopPropagation();
            run(api.host.sendNext(requestId));
          }}
        >
          Send Now
        </button>
      </Tip>
      <span aria-hidden="true">·</span>
      <Tip label="Your agent reads it now: a long command or a stuck turn is interrupted">
        <button
          type="button"
          className={p.steerNow}
          onClick={(e) => {
            e.stopPropagation();
            run(api.host.promote(requestId, { interrupt: true }));
          }}
        >
          Steer Now
        </button>
      </Tip>
    </>
  );
}

/**
 * Messages waiting for a task's Claude (the head Claude's, or yours), on its card: “2 messages
 * waiting · Send Now · Steer Now” for the next one in the queue. `each`: one line per message with
 * its own Send Now and Steer Now (the task's panel). One already in the running turn just says so.
 */
export function WaitingLine({ waiting, each }: { waiting: readonly WaitingMessage[]; each?: boolean }) {
  if (!waiting.length) return null;
  if (each) {
    return (
      <span className={p.waitingList}>
        {waiting.map((w) => (
          <span key={w.requestId} className={p.waitingLine}>
            <Tip label={snippet(w.prompt)}>
              <span className={p.waitingWords}>{snippet(w.prompt).slice(0, 48)}</span>
            </Tip>
            {w.queued ? <SendOrSteer requestId={w.requestId} /> : <span className={p.muted}>· read at the agent’s next step</span>}
          </span>
        ))}
      </span>
    );
  }
  const { text: words, steer } = waitingWords(waiting);
  return (
    <span className={p.waitingLine}>
      <Tip label={waiting.map((w) => snippet(w.prompt)).join('\n')}>
        <span className={p.waitingWords}>{words}</span>
      </Tip>
      {steer ? <SendOrSteer requestId={steer} /> : <span className={p.muted}>· read at the agent’s next step</span>}
    </span>
  );
}
