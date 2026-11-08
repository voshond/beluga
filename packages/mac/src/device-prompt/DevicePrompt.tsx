import { invoke } from '@tauri-apps/api/core';
import { type KeyboardEvent, useEffect, useState } from 'react';
import { askedBy, secondsLeft } from './prompt-model.js';

/**
 * The approval window for a server's device request (src-tauri/src/device.rs): what will run,
 * where, who asked and why. Deny has the focus; Escape or closing the window is a no too.
 */

export type DevicePromptView = {
  readonly id: string;
  readonly kind: 'run';
  readonly device: string;
  readonly conversation: string | null;
  readonly agent: string | null;
  readonly why: string;
  readonly cwd: string;
  readonly command: string;
  readonly timeoutSec: number;
  readonly expiresAt: number;
};

export const DevicePrompt = () => {
  const [prompt, setPrompt] = useState<DevicePromptView | null | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invoke<DevicePromptView | null>('device_prompt')
      .then(setPrompt)
      .catch(() => setPrompt(null));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const handleAnswer = (approve: boolean) => {
    setBusy(true);
    void invoke('device_prompt_answer', { approve }).catch(() => setBusy(false));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') handleAnswer(false);
  };

  if (prompt === undefined) return null;
  if (prompt === null) return <main className="device-prompt">Nothing is waiting for your approval.</main>;

  return (
    <main className="device-prompt" onKeyDown={handleKeyDown} aria-labelledby="device-prompt-title">
      <h1 id="device-prompt-title">Run this command on {prompt.device}?</h1>
      <p className="device-prompt-who">{askedBy(prompt)}</p>
      {prompt.why ? <p className="device-prompt-why">“{prompt.why}”</p> : null}
      <pre className="device-prompt-command" aria-label="Command" tabIndex={0}>
        {prompt.command}
      </pre>
      <dl className="device-prompt-facts">
        <dt>In</dt>
        <dd>{prompt.cwd}</dd>
        <dt>Stops after</dt>
        <dd>{prompt.timeoutSec} s</dd>
      </dl>
      <p className="device-prompt-hint">It runs in your login shell with no input. Only approve what you understand.</p>
      <div className="device-prompt-actions">
        <span className="device-prompt-left" aria-live="polite">
          Denied by itself in {secondsLeft(prompt.expiresAt, now)} s
        </span>
        <button type="button" onClick={() => handleAnswer(true)} disabled={busy}>
          Run
        </button>
        <button type="button" className="device-prompt-deny" onClick={() => handleAnswer(false)} disabled={busy} autoFocus>
          Deny
        </button>
      </div>
    </main>
  );
};
