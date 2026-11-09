import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import s from './sheet.module.css';
import f from './folder-browser.module.css';

/**
 * A browser's folder picker (BLG-651, docs/web.md): the browser can't see the folders of
 * the computer Beluga runs on, so this sheet walks them through `local.browse`. Where the app
 * shows the Open panel (Add Project, Share a Folder, a folder friends' agents may use), a page
 * served by the web port asks `browseFolder()` instead, and gets the folder you chose.
 */

interface Ask {
  readonly title: string;
  readonly action: string;
  readonly start?: string;
  /** One of your computers' folders (BLG-793): walked with its own local.browse, and named. */
  readonly on?: { readonly name: string; readonly browse: (dir?: string) => Promise<Browsed> };
  readonly done: (path: string | undefined) => void;
}

let asking: Ask | undefined;
const listeners = new Set<() => void>();
const set = (next: Ask | undefined): void => {
  asking = next;
  for (const l of [...listeners]) l();
};

/** Ask for a folder of the computer Beluga runs on (or `on`, one of your computers); undefined when you cancel. */
export function browseFolder(title: string, opts: { action?: string; start?: string; on?: Ask['on'] } = {}): Promise<string | undefined> {
  asking?.done(undefined);
  return new Promise((resolve) => set({ title, action: opts.action ?? 'Choose', ...(opts.start ? { start: opts.start } : {}), ...(opts.on ? { on: opts.on } : {}), done: resolve }));
}

type Browsed = Awaited<ReturnType<ReturnType<typeof useApi>['local']['browse']>>;

/** The sheet, while something asks for a folder (mounted once, beside the app). */
export function FolderBrowserHost() {
  const ask = useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => asking,
  );
  if (!ask) return null;
  const finish = (path: string | undefined): void => {
    set(undefined);
    ask.done(path);
  };
  return <FolderBrowser ask={ask} onDone={finish} />;
}

function FolderBrowser({ ask, onDone }: { ask: Ask; onDone: (path: string | undefined) => void }) {
  const api = useApi();
  const [at, setAt] = useState<Browsed>();
  const [error, setError] = useState<string>();
  const go = (dir?: string): void => {
    setError(undefined);
    (ask.on ? ask.on.browse(dir) : api.local.browse(dir)).then(setAt, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  useEffect(() => go(ask.start), [ask]);
  const short = (p: string): string => (at && p.startsWith(at.home) ? `~${p.slice(at.home.length)}` : p);
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : onDone(undefined))}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} style={{ zIndex: 60 }} />
        <Dialog.Content className={cx(s.sheet, f.sheet)} style={{ zIndex: 61 }} aria-describedby={undefined}>
          <div className={s.head}>
            <Dialog.Title className={s.title}>{ask.title}</Dialog.Title>
            <Dialog.Close className={s.close} aria-label="Cancel">
              <Icon name="x" size={12} />
            </Dialog.Close>
          </div>
          <div className={f.where}>
            <button type="button" className={f.up} aria-label="Up one folder" disabled={!at?.parent} onClick={() => go(at?.parent)}>
              <Icon name="chevronUp" size={13} />
            </button>
            <span className={f.path} title={at?.path}>
              {at ? short(at.path) : '…'}
            </span>
            <button type="button" className={f.up} aria-label="Home" disabled={!at || at.path === at.home} onClick={() => go(at?.home)}>
              <Icon name="person" size={13} />
            </button>
          </div>
          <div className={f.list} role="list" aria-label="Folders">
            {error ? <div className={f.note}>{error}</div> : !at ? <div className={f.note}>Looking…</div> : at.dirs.length === 0 ? <div className={f.note}>No folders in here.</div> : null}
            {at?.dirs.map((d) => (
              <button key={d.name} type="button" role="listitem" className={f.row} onClick={() => go(`${at.path.replace(/[\\/]+$/, '')}/${d.name}`)}>
                <Icon name={d.git ? 'branch' : 'folder'} size={14} />
                <span className={f.name}>{d.name}</span>
                {d.git ? <span className={f.badge}>git</span> : null}
                <Icon name="chevronRight" size={12} />
              </button>
            ))}
          </div>
          <div className={f.footer}>
            <span className={f.hint}>{ask.on ? `On ${ask.on.name}` : 'On the computer Beluga runs on'}</span>
            <Button variant="quiet" onClick={() => onDone(undefined)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!at} onClick={() => at && onDone(at.path)}>
              {ask.action} “{at ? (at.path.split(/[\\/]/).filter(Boolean).pop() ?? at.path) : '…'}”
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
