import { useEffect, useState } from 'react';
import type { BelugaClient } from '@beluga/ipc/client.js';
import { HONCHO_CLOUD_URL, HONCHO_LOCAL_URL } from '@beluga/shared/honcho.js';
import { Button } from '../components/ui.js';
import { useApp, useBeluga } from '../lib/beluga.js';
import { computerTitle } from '../lib/os-words.js';
import { useClock } from '../lib/window-active.js';
import { ago } from '../phone/phone-model.js';
import p from '../phone/phone.module.css';
import { Group, Row, Switch } from './settings-controls.js';
import s from './settings.module.css';

type HonchoApi = BelugaClient['api']['honcho'];
type Status = Awaited<ReturnType<HonchoApi['status']>>;
type Patch = Parameters<HonchoApi['configure']>[0];
type Picture = Awaited<ReturnType<HonchoApi['picture']>>;
type Check = { readonly ok: boolean; readonly text: string };

const REFRESH_MS = 10_000;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const sentText = (status: Status, now: number): string => {
  if (!status.sent) return status.enabled ? 'Nothing yet. Your next message in a chat or worktree goes.' : 'Nothing yet.';
  const last = status.lastSentAt ? `, the last ${ago(status.lastSentAt, now)}` : '';
  return `${status.sent} message${status.sent === 1 ? '' : 's'}${last}.`;
};

export function HonchoSettings() {
  const { client } = useBeluga();
  const projects = useApp((st) => st.projects);
  const [status, setStatus] = useState<Status>();
  const [urlDraft, setUrlDraft] = useState<string>();
  const [workspaceDraft, setWorkspaceDraft] = useState<string>();
  const [apiKey, setApiKey] = useState('');
  const [check, setCheck] = useState<Check>();
  const [keyNote, setKeyNote] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [picture, setPicture] = useState<Picture>();
  const [pictureBusy, setPictureBusy] = useState(false);

  const tick = useClock(true, REFRESH_MS);
  useEffect(() => {
    client.api.honcho.status().then(setStatus, (err: unknown) => setError(errorText(err)));
  }, [client, tick]);

  const enabled = status?.enabled ?? false;
  const loadPicture = (): void => {
    setPictureBusy(true);
    client.api.honcho
      .picture()
      .then(setPicture, (err: unknown) => setPicture({ enabled: true, text: '', error: errorText(err) }))
      .finally(() => setPictureBusy(false));
  };
  useEffect(() => {
    if (enabled) loadPicture();
    else setPicture(undefined);
  }, [client, enabled]);

  if (!status) return error ? <div className={p.error}>{error}</div> : null;

  const url = urlDraft ?? status.url;
  const workspace = workspaceDraft ?? status.workspace;
  const movingKey = status.hasKey && Boolean(url.trim()) && url.trim().replace(/\/+$/, '') !== status.url;

  const save = (patch: Patch): void => {
    setError(undefined);
    client.api.honcho.configure(patch).then(
      (next) => {
        setKeyNote(status.hasKey && !next.hasKey && next.url !== status.url ? `The saved key was for ${status.url}, so Beluga forgot it. Type ${next.url}’s key if it needs one.` : undefined);
        setStatus(next);
        setUrlDraft(undefined);
        setWorkspaceDraft(undefined);
      },
      (err: unknown) => setError(errorText(err)),
    );
  };

  const handleToggle = (on: boolean): void => save({ enabled: on });
  const handleSaveUrl = (): void => {
    if (!url.trim() || url.trim() === status.url) return;
    save({ url: url.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
    setApiKey('');
  };
  const handleSaveWorkspace = (): void => {
    if (workspace.trim() && workspace.trim() !== status.workspace) save({ workspace: workspace.trim() });
  };
  const handleSaveKey = (): void => {
    if (!apiKey.trim()) return;
    save({ apiKey: apiKey.trim() });
    setApiKey('');
  };
  const handleForgetKey = (): void => save({ apiKey: null });
  const handleTest = (): void => {
    setBusy(true);
    setCheck(undefined);
    client.api.honcho
      .test({ ...(url.trim() ? { url: url.trim() } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
      .then(
        (r) => setCheck(r.ok ? { ok: true, text: 'Connected. Honcho answered and the workspace is ready.' } : { ok: false, text: r.error }),
        (err: unknown) => setCheck({ ok: false, text: errorText(err) }),
      )
      .finally(() => setBusy(false));
  };
  const handleProject = (id: string, send: boolean): void => save({ excluded: send ? status.excluded.filter((x) => x !== id) : [...status.excluded, id] });

  return (
    <>
      <Group title="Honcho">
        <Row label="Send conversations to Honcho" detail={`Your own messages and your agents’ answers in your chats, worktrees and Your ${computerTitle()} go to Honcho, which learns how you work. Friends’ messages, runs for friends, tool output and anything that looks like a secret stay here. Only what you say from now on is sent.`}>
          <Switch on={status.enabled} onChange={handleToggle} label="Send conversations to Honcho" />
        </Row>
        <Row
          label="Server"
          detail={
            movingKey
              ? `The saved key only goes to ${status.url}: saving this address forgets it. Type the new server’s key below first to save both together.`
              : `Your own server, on this computer or your network (http://<host>:8000), or Honcho’s cloud at ${HONCHO_CLOUD_URL}.`
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSaveUrl();
            }}
          >
            <input aria-label="Honcho server" className={s.text} value={url} spellCheck={false} placeholder={HONCHO_LOCAL_URL} onChange={(e) => setUrlDraft(e.target.value)} onBlur={handleSaveUrl} />
          </form>
        </Row>
        <Row
          label="API key"
          detail={keyNote ?? (status.hasKey ? `A key for ${status.url} is saved on this computer, readable only by you. It only ever goes to that server. Type a new one to replace it.` : 'Leave it empty for your own server without auth. For Honcho’s cloud, a key from app.honcho.dev.')}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSaveKey();
            }}
          >
            <input aria-label="Honcho API key" type="password" autoComplete="off" className={s.text} value={apiKey} spellCheck={false} placeholder={status.hasKey ? '••••••••' : 'none'} onChange={(e) => setApiKey(e.target.value)} onBlur={handleSaveKey} />
          </form>
          {status.hasKey ? (
            <Button size="small" variant="quiet" onClick={handleForgetKey}>
              Forget
            </Button>
          ) : null}
        </Row>
        <Row label="Workspace" detail="Honcho keeps Beluga’s conversations together under this name.">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSaveWorkspace();
            }}
          >
            <input aria-label="Honcho workspace" className={s.text} value={workspace} spellCheck={false} onChange={(e) => setWorkspaceDraft(e.target.value)} onBlur={handleSaveWorkspace} />
          </form>
        </Row>
        <Row label="Test connection" detail={check?.text ?? 'Checks the server and key above, saved or not. The saved key is only sent to the saved server: to test another address, type its key.'}>
          <Button size="small" disabled={busy} onClick={handleTest}>
            {busy ? 'Testing…' : 'Test'}
          </Button>
        </Row>
        <Row label="Sent" detail={status.lastError && status.enabled ? `Last problem: ${status.lastError}. Beluga tries again later; runs are never held up.` : undefined}>
          <span className={s.mono}>{sentText(status, Date.now())}</span>
        </Row>
      </Group>
      {error ? <div className={p.error}>{error}</div> : null}
      {status.enabled ? (
        <Group title="What Honcho knows about you">
          <Row
            label="Honcho’s picture of you"
            detail={picture?.error ? `Couldn’t read it: ${picture.error}. Runs start without it.` : 'Inferred from your conversations. Your own runs get it as background (never a friend’s); Beluga’s memory wins where they disagree.'}
          >
            <Button size="small" variant="quiet" disabled={pictureBusy} onClick={loadPicture}>
              {pictureBusy ? 'Reading…' : 'Refresh'}
            </Button>
          </Row>
          <div className={s.picture}>
            {picture ? picture.text || 'Nothing yet: Honcho hasn’t learned enough about you. It reasons over conversations in the background, so this lags a little.' : 'Reading…'}
          </div>
        </Group>
      ) : null}
      {status.enabled ? (
        <Group title="Projects sent to Honcho">
          {projects.map((project) => (
            <Row key={project.id} label={project.name} detail={project.root || undefined}>
              <Switch on={!status.excluded.includes(project.id)} onChange={(on) => handleProject(project.id, on)} label={`Send ${project.name} to Honcho`} />
            </Row>
          ))}
        </Group>
      ) : null}
    </>
  );
}
