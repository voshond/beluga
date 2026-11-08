import { useState, type FormEvent } from 'react';
import type { PendingQuestion } from '@beluga/core/collab-store.js';
import { runnableQuestion } from '@beluga/core/run-ask.js';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import f from '../components/form.module.css';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import a from './attention.module.css';
import s from './run-ask.module.css';

type RunAskProps = {
  readonly q: PendingQuestion;
  readonly question: string;
};

const OUTPUT_LINES = 200;

export const useRunStarted = (qid: string): boolean =>
  useApp((st) => {
    const status = st.runAsks[qid]?.status;
    return status === 'running' || status === 'done';
  });

const lastLines = (output: string): string => output.split('\n').slice(-OUTPUT_LINES).join('\n');

const latestLine = (output: string): string =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

type TrailProps = {
  readonly output: string;
  readonly open: boolean;
  readonly onToggle: () => void;
};

const Trail = ({ output, open, onToggle }: TrailProps) => (
  <>
    <button type="button" className={s.toggle} aria-expanded={open} onClick={onToggle}>
      <Icon name={open ? 'chevronUp' : 'chevronDown'} size={10} />
      {open ? 'Hide output' : 'Show output'}
    </button>
    {open ? (
      <pre className={cx(a.detail, s.output, 'selectable')} aria-label="What it printed">
        <span>{lastLines(output) || ' '}</span>
      </pre>
    ) : null}
  </>
);

export function RunAsk({ q, question }: RunAskProps) {
  const api = useApi();
  const { client } = useBeluga();
  const selfId = useApp((st) => st.selfId);
  const state = useApp((st) => st.runAsks[q.qid]);
  const [reply, setReply] = useState('');
  const [starting, setStarting] = useState(false);
  const [trailChoice, setTrailChoice] = useState<boolean>();
  const run = runnableQuestion(q, selfId, question);
  if (!run) return null;

  const handleRun = (): void => {
    setStarting(true);
    api.questions.run(q.qid, question).then(
      () => setStarting(false),
      (err: unknown) => {
        setStarting(false);
        toast(client, err instanceof Error ? err.message : String(err), 'error');
      },
    );
  };

  const handleStop = (): void => void api.questions.runStop(q.qid);

  const handleReply = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    void api.questions.runInput(q.qid, reply);
    setReply('');
  };

  const where = run.on ?? 'this machine';
  const trailOpen = trailChoice ?? state?.status === 'failed';
  const handleToggleTrail = (): void => setTrailChoice(!trailOpen);

  if (state?.status !== 'running') {
    return (
      <div className={s.run}>
        <div className={a.actions}>
          <Button variant="primary" icon="play" disabled={starting} onClick={handleRun}>
            {state ? 'Run it again' : 'Run it for me'}
          </Button>
          <span className={a.hint}>
            on <strong>{state?.where ?? where}</strong>: you type any password here, your agent only gets what it prints
          </span>
        </div>
        {state?.status === 'stopped' ? <div className={a.hint}>You stopped it.</div> : null}
        {state?.error ? <div className={cx(a.hint, s.error)}>{state.error}</div> : null}
        {state?.output ? <Trail output={state.output} open={trailOpen} onToggle={handleToggleTrail} /> : null}
      </div>
    );
  }

  return (
    <div className={s.run} role="group" aria-label={`Running on ${state.where}`}>
      <div className={a.actions}>
        <span className={s.running} aria-live="polite">
          Running on <strong>{state.where}</strong>…
        </span>
        <Button size="small" variant="quiet" onClick={handleStop}>
          Stop
        </Button>
      </div>
      {!trailOpen && !state.prompt && latestLine(state.output) ? <div className={s.latest}>{latestLine(state.output)}</div> : null}
      <Trail output={state.output} open={trailOpen} onToggle={handleToggleTrail} />
      {state.prompt ? (
        <form className={s.reply} onSubmit={handleReply}>
          <label className={s.promptText} htmlFor={`run-ask-${q.qid}`}>
            {state.prompt.text}
          </label>
          <div className={s.replyRow}>
            <input
              id={`run-ask-${q.qid}`}
              className={cx(f.input, s.replyInput)}
              type={state.prompt.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              placeholder={state.prompt.secret ? 'Password' : 'Your reply'}
              aria-label={state.prompt.secret ? 'Password, sent only to the command' : 'Your reply to the command'}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
            />
            <Button variant="primary" type="submit">
              {state.prompt.secret ? 'Unlock' : 'Send'}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
