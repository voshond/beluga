import { useEffect, useState } from 'react';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { type ReadyRun, type ReadyStep, readyLine } from '@beluga/machines/ready-model.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { copyText } from '../lib/copy.js';
import side from '../layout/Sidebar.module.css';
import c from './machines.module.css';

/**
 * Getting a computer ready for a project (BLG-787), as it happens, on the new worktree: each step
 * (its folder, the clone, the tools it needs, its setup) with how it's going, what's missing there
 * and how it would be installed (Install Them, only when you say), and any error in plain words
 * with its fix.
 */

const POLL_MS = 700;

/** A run on `client`'s computer, followed until it's done or fails (or waits on you). */
export function useReadyRun(client: SocketClient, first: ReadyRun): ReadyRun {
  const [run, setRun] = useState(first);
  useEffect(() => setRun(first), [first.id]);
  useEffect(() => {
    if (run.state === 'done' || run.state === 'failed') return;
    const timer = setTimeout(() => {
      void client.call('machines.ready.status', run.id).then(
        (next) => next && setRun(next as ReadyRun),
        () => undefined,
      );
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [client, run]);
  return run;
}

function StepMark({ step }: { step: ReadyStep }) {
  switch (step.state) {
    case 'active':
      return <span className={side.making} aria-hidden="true" />;
    case 'done':
      return <Icon name="check" size={12} />;
    case 'failed':
      return <Icon name="alert" size={12} />;
    case 'asking':
      return <Icon name="hand" size={12} />;
    case 'skipped':
      return <Icon name="minus" size={12} />;
    default:
      return <span className={c.todo} aria-hidden="true" />;
  }
}

export function GettingReady({ client, run: first, onRetry }: { client: SocketClient; run: ReadyRun; onRetry?: () => void }) {
  const run = useReadyRun(client, first);
  const [installing, setInstalling] = useState(false);
  const install = (): void => {
    setInstalling(true);
    void client.call('machines.ready.install', run.id).finally(() => setInstalling(false));
  };
  const blocked = run.missing?.filter((p) => !p.can) ?? [];
  return (
    <section className={c.ready} aria-label={`Getting ${run.computer} ready`} data-ready={run.state}>
      <div className={c.readyTitle} role="status">
        {readyLine(run)}
      </div>
      <ol className={c.steps}>
        {run.steps.map((step) => (
          <li key={step.id} className={c.step} data-state={step.state}>
            <span className={c.stepMark}>
              <StepMark step={step} />
            </span>
            <span className={c.stepText}>
              <span className={c.stepLabel}>{step.label}</span>
              {step.error ? <span className={c.stepError}>{step.error}</span> : step.detail ? <span className={c.stepDetail}>{step.detail}</span> : null}
              {step.fix ? (
                <span className={c.stepFix}>
                  {step.fix.words}
                  {step.fix.command ? (
                    <>
                      : <code>{step.fix.command}</code>
                      <Button size="small" variant="quiet" icon="copy" onClick={() => void copyText(step.fix!.command!)}>
                        Copy
                      </Button>
                    </>
                  ) : null}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {run.state === 'asking' && run.missing?.length ? (
        <div className={c.asking}>
          <div>To install on {run.computer}:</div>
          <ul>
            {run.missing.map((p) => (
              <li key={p.tool}>{p.can ? p.words : p.why}</li>
            ))}
          </ul>
          {blocked.length ? null : (
            <Button size="small" onClick={install} disabled={installing}>
              {installing ? 'Installing…' : 'Install Them'}
            </Button>
          )}
        </div>
      ) : null}
      {run.state === 'failed' && onRetry ? (
        <Button size="small" onClick={onRetry}>
          Try Again
        </Button>
      ) : null}
    </section>
  );
}
