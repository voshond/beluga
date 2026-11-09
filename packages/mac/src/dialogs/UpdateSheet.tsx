import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useEffect, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Icon, type IconName } from '../components/Icon.js';
import { UpdatePill } from '../components/UpdatePill.js';
import { Button, cx } from '../components/ui.js';
import { useMaybeBeluga } from '../lib/beluga.js';
import { usePrefs } from '../lib/prefs.js';
import { openExternal } from '../lib/system.js';
import { idleLine, lastCheckedLabel, shortVersion } from '../lib/update-model.js';
import { checkForUpdates, closeUpdateSheet, dismissNews, restartNow, setUpdateMode, startUpdates, updateLater, updateWhenIdle, useUpdates } from '../lib/updates.js';
import s from '../components/update.module.css';

/** Links in release notes open in the browser, never in the window. */
const NOTE_PARTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void openExternal(href);
      }}
    >
      {children}
    </a>
  ),
};

function Notes({ text }: { text: string | null | undefined }) {
  if (!text?.trim()) return null;
  return (
    <div className={cx(s.notes, 'selectable')} aria-label="What’s new">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={NOTE_PARTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Head({ icon, title, sub }: { icon: IconName; title: string; sub?: string }) {
  return (
    <div className={s.head}>
      <span className={s.mark}>
        <Icon name={icon} size={15} />
      </span>
      <div className={s.titles}>
        <Dialog.Title className={s.title}>{title}</Dialog.Title>
        {sub ? <div className={s.sub}>{sub}</div> : null}
      </div>
      <Dialog.Close className={s.close} aria-label="Close">
        <Icon name="x" size={12} />
      </Dialog.Close>
    </div>
  );
}

const day = (date: string | null | undefined): string | undefined => {
  const t = date ? Date.parse(date) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : undefined;
};

type Behind = { readonly id: string; readonly name: string; readonly version?: string };

/**
 * Computers this update would leave unable to connect (BLG-777): on an older protocol than the
 * new version's. Each gets Update … First (it updates once nothing runs there).
 */
function LeftBehind({ ipc }: { ipc: number | null | undefined }) {
  const beluga = useMaybeBeluga();
  const [behind, setBehind] = useState<readonly Behind[]>([]);
  const [said, setSaid] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!beluga || ipc === undefined || ipc === null) return;
    let live = true;
    void beluga.client.call('machines.leftBehind', ipc).then(
      (list) => live && setBehind(list as readonly Behind[]),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [beluga, ipc]);
  if (!beluga || !behind.length) return null;
  const update = (m: Behind): void =>
    void beluga.client.call('machines.update', m.id, 'when-idle').then(
      (a) => setSaid((s) => ({ ...s, [m.id]: (a as { message: string }).message })),
      (err: unknown) => setSaid((s) => ({ ...s, [m.id]: err instanceof Error ? err.message : String(err) })),
    );
  return (
    <div className={cx(s.line, s.warn)} data-left-behind>
      {behind.map((m) => (
        <p key={m.id}>
          {said[m.id] ?? `${m.name} runs an older Beluga${m.version ? ` (${m.version})` : ''}: after this update your app can't work there until it's updated too.`}{' '}
          {said[m.id] ? null : (
            <Button size="small" onClick={() => update(m)}>
              Update {m.name} First
            </Button>
          )}
        </p>
      ))}
    </div>
  );
}

/** A downloaded update: what's in it, and when it goes in. */
function Ready() {
  const { state, claude } = useUpdates();
  const available = state.available!;
  const installing = state.phase === 'installing';
  const released = day(available.date);
  return (
    <>
      <Head icon="download" title={`Beluga ${shortVersion(available.version)} is ready`} sub={`You have ${state.current}${released ? ` · released ${released}` : ''}`} />
      <Notes text={available.notes} />
      {!installing ? <LeftBehind ipc={available.ipc} /> : null}
      {claude > 0 && !installing ? (
        <p className={cx(s.line, s.warn)}>
          Your agent is working ({claude} {claude === 1 ? 'run' : 'runs'}). Restart Now stops it; Update When Idle waits until it’s done.
        </p>
      ) : null}
      {state.choice === 'idle' && !installing ? <p className={s.line}>{idleLine(state.waitingOn)}</p> : null}
      {state.error ? <p className={cx(s.line, s.error)}>{state.error}</p> : null}
      {state.mode !== 'off' && !installing ? (
        <label className={s.always}>
          <input type="checkbox" checked={state.mode === 'idle'} onChange={(e) => void setUpdateMode(e.target.checked ? 'idle' : 'ask')} />
          Update automatically from now on
        </label>
      ) : null}
      <div className={s.foot}>
        <Button variant="quiet" onClick={() => void updateLater()} disabled={installing} title="Installs the next time you quit Beluga">
          Later
        </Button>
        <span className={s.spacer} />
        <Button onClick={() => void updateWhenIdle()} disabled={installing} title="Installs once you step away and nothing is running, then reopens in the background">
          Update When Idle
        </Button>
        <Button variant="primary" onClick={() => void restartNow()} disabled={installing}>
          {installing ? 'Restarting…' : 'Restart Now'}
        </Button>
      </div>
    </>
  );
}

/** After an update installed: what changed. */
function News() {
  const { state } = useUpdates();
  const news = state.news!;
  return (
    <>
      <Head icon="check" title={`Beluga is now ${shortVersion(news.version)}`} sub="Updated while you were away." />
      <Notes text={news.notes} />
      <div className={s.foot}>
        <Button variant="primary" onClick={() => void dismissNews()}>
          OK
        </Button>
      </div>
    </>
  );
}

/** Looking, downloading, up to date, or couldn't. */
function Status() {
  const { state } = useUpdates();
  const busy = state.phase === 'checking' || state.phase === 'downloading';
  const head: Record<string, [IconName, string]> = {
    checking: ['refresh', 'Checking for updates…'],
    downloading: ['download', 'Downloading the update…'],
    error: ['alert', 'Couldn’t check for updates'],
  };
  const [icon, title] = head[state.phase] ?? ['check', 'Beluga is up to date'];
  return (
    <>
      <Head icon={icon} title={title} sub={`Beluga ${state.current} · last checked ${lastCheckedLabel(state.lastCheck).toLowerCase()}`} />
      {state.phase === 'downloading' ? (
        <div className={s.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((state.progress ?? 0) * 100)}>
          <div className={s.barFill} style={{ width: `${Math.round((state.progress ?? 0) * 100)}%` }} />
        </div>
      ) : null}
      {state.phase === 'downloading' ? <p className={s.line}>It downloads in the background; you can close this.</p> : null}
      {state.phase === 'error' && state.error ? <p className={cx(s.line, s.error)}>{state.error}</p> : null}
      <div className={s.foot}>
        {state.phase === 'error' ? <Button onClick={() => void checkForUpdates()}>Try Again</Button> : null}
        <Button variant="primary" onClick={closeUpdateSheet}>
          {busy ? 'Hide' : 'OK'}
        </Button>
      </div>
    </>
  );
}

export function UpdateSheet() {
  const { state, open } = useUpdates();
  if (!open) return null;
  let body: ReactNode;
  if (state.available) body = <Ready />;
  else if (state.news && state.phase !== 'checking' && state.phase !== 'downloading') body = <News />;
  else body = <Status />;
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : closeUpdateSheet())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.sheet} aria-describedby={undefined} data-update-sheet onOpenAutoFocus={(e) => e.preventDefault()}>
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Beluga's updates in the window, whether or not Beluga itself is reachable: the sheet, and the
 * pill in a corner when there's no sidebar to hold it (see Sidebar for the usual place).
 */
export function UpdateLayer({ connected }: { connected: boolean }) {
  const prefs = usePrefs();
  useEffect(() => startUpdates(), []);
  return (
    <>
      {!connected || !prefs.sidebar ? <UpdatePill floating /> : null}
      <UpdateSheet />
    </>
  );
}
