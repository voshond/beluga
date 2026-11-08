import { useState, type FormEvent } from 'react';
import type { PendingQuestion } from '@beluga/core/collab-store.js';
import { runnableQuestion } from '@beluga/core/run-ask.js';
import { Button, cx } from '../components/ui.js';
import f from '../components/form.module.css';
import { toast, useApi, useApp, useBeluga } from '../lib/beluga.js';
import a from './attention.module.css';
import s from './run-ask.module.css';

type RunAskProps = {
  readonly q: PendingQuestion;
  readonly question: string;
};

const OUTPUT_LINES = 40;

const lastLines = (output: string): string => output.split('\n').slice(-OUTPUT_LINES).join('\n');

export function RunAsk({ q, question }: RunAskProps) {
  const api = useApi();
  const { client } = useBeluga();
  const selfId = useApp((st) => st.selfId);
  const state = useApp((st) => st.runAsks[q.qid]);
  const [reply, setReply] = useState('');
  const [starting, setStarting] = useState(false);
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
        {state?.output ? <pre className={cx(a.detail, s.output, 'selectable')}>{lastLines(state.output)}</pre> : null}
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
      <pre className={cx(a.detail, s.output, 'selectable')} aria-label="What it printed">
        {lastLines(state.output) || ' '}
      </pre>
      {state.prompt ? (
        <form className={s.reply} onSubmit={handleReply}>
          <label className={s.promptText} htmlFor={`run-ask-${q.qid}`}>
            {state.prompt.text}
          </label>
          <input
            id={`run-ask-${q.qid}`}
            className={cx(f.input, s.replyInput)}
            type={state.prompt.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-label={state.prompt.secret ? 'Password, sent only to the command' : 'Your reply to the command'}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
          />
          <Button size="small" variant="primary" type="submit">
            Send
          </Button>
        </form>
      ) : null}
    </div>
  );
}
