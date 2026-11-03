import { baseName, sepOf } from '@beluga/shared/os-path.js';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DotMatrix } from '../components/DotMatrix.js';
import { Icon } from '../components/Icon.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { Button, Segmented, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { inApp } from '../lib/boot.js';
import { useApi, useApp, useBeluga, useUi } from '../lib/beluga.js';
import { pickFolders } from '../lib/projects.js';
import s from './add-project.module.css';
import { thisComputer } from '../lib/os-words.js';
import { CloneProject } from './CloneProject.js';

interface Found {
  readonly path: string;
  readonly name: string;
  readonly changed: number;
}

const ago = (ts: number): string => {
  const d = Math.max(0, (Date.now() - ts) / 1000);
  if (d < 3600) return 'just now';
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86_400 * 30) return `${Math.floor(d / 86_400)}d ago`;
  return `${Math.floor(d / (86_400 * 30))}mo ago`;
};

type Mode = 'add' | 'new' | 'clone';

/** A folder you added here: on its way (adding takes a moment), in, or why it couldn't be. */
type Row = { readonly kind: 'adding' } | { readonly kind: 'added' } | { readonly kind: 'failed'; readonly error: string };

/** Suggestions shown before you filter (Filter searches every one found). */
const NEWEST = 24;

/**
 * Add projects the Mac way: drop folders on it, choose them in the Open panel, or pick from the
 * git projects already on this Mac (most recently worked on first). Or start a new one.
 */
export function AddProjectSheet() {
  const { ui } = useBeluga();
  const api = useApi();
  const asked = useUi((u) => u.addProject ?? false);
  const open = asked !== false;
  const [mode, setMode] = useState<Mode>('add');
  const home = useApp((st) => st.home);
  const roots = useApp((st) => st.projects.map((p) => p.root).filter(Boolean).join('\n'));
  // Projects you hid: listed too, with Show (they come back where they were).
  const hidden = useApp((st) => st.hiddenProjects.join('\n'));
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  const [found, setFound] = useState<Found[] | undefined>();
  const [rows, setRows] = useState<ReadonlyMap<string, Row>>(new Map());
  const [filter, setFilter] = useState('');
  const [typed, setTyped] = useState('');
  const [over, setOver] = useState(false);
  const filterBox = useRef<HTMLInputElement>(null);
  const close = (): void => ui.patch({ addProject: false });
  const short = (p: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  useEffect(() => {
    if (!open) return;
    setMode(asked === 'new' ? 'new' : 'add');
    setRows(new Map());
    setRevealed(new Set());
    setFilter('');
    setFound(undefined);
    void api.projects.suggest().then(setFound, () => setFound([]));
  }, [open, asked]);

  const mark = (path: string, row: Row): void => setRows((m) => new Map(m).set(path, row));
  // Each folder shows Adding… on its row at once, then Added or what went wrong.
  const add = async (paths: readonly string[]): Promise<void> => {
    await Promise.all(
      paths.map(async (p) => {
        mark(p, { kind: 'adding' });
        const res = await api.projects.add(p).catch((err: unknown) => ({ error: errorText(err) }));
        mark(p, res.error ? { kind: 'failed', error: res.error } : { kind: 'added' });
      }),
    );
  };

  // Folders dropped anywhere on the window while this is open are added.
  useEffect(() => {
    if (!open || mode !== 'add' || !inApp()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const un = await getCurrentWebview().onDragDropEvent((e) => {
        if (e.payload.type === 'over' || e.payload.type === 'enter') setOver(true);
        else if (e.payload.type === 'leave') setOver(false);
        else if (e.payload.type === 'drop') {
          setOver(false);
          void add(e.payload.paths);
        }
      });
      if (alive) off = un;
      else un();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [open, mode]);

  const show = async (path: string): Promise<void> => {
    if (await api.workspaces.showProject(path)) setRevealed((r) => new Set([...r, path]));
  };

  const hiddenSet = useMemo(() => new Set(hidden.split('\n').filter(Boolean)), [hidden]);
  const shown = useMemo(() => {
    const known = new Set(roots.split('\n'));
    const q = filter.trim().toLowerCase();
    const listed = new Set((found ?? []).map((f) => f.path));
    // Folders you dropped, chose or typed (not among the suggestions) and hidden projects come first.
    const extra = found ? [...rows.keys(), ...hiddenSet, ...revealed].filter((p, i, all) => !listed.has(p) && all.indexOf(p) === i).map((p): Found => ({ path: p, name: baseName(p) || p, changed: 0 })) : [];
    const newest = (found ?? []).filter((f, i) => q || i < NEWEST || rows.has(f.path));
    return [...extra, ...newest]
      .filter((f) => !known.has(f.path) || rows.has(f.path) || revealed.has(f.path))
      .filter((f) => !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q));
  }, [found, filter, roots, rows, hiddenSet, revealed]);

  const choose = async (): Promise<void> => {
    const picked = await pickFolders('Add projects');
    if (picked) await add(picked);
  };

  if (!open) return null;
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.sheet} aria-describedby={undefined} onOpenAutoFocus={(e) => (e.preventDefault(), mode === 'add' && filterBox.current?.focus())}>
          <div className={s.head}>
            <Dialog.Title className={s.title}>{mode === 'new' ? 'New project' : 'Add projects'}</Dialog.Title>
            <Dialog.Close className={s.close} aria-label="Close">
              <Icon name="x" size={11} />
            </Dialog.Close>
          </div>

          <div className={s.modes}>
            <Segmented<Mode>
              label="Add or start a project"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'add', label: 'Add existing', icon: 'folder' },
                { value: 'new', label: 'Start new', icon: 'plus' },
                { value: 'clone', label: 'GitHub', icon: 'folder' },
              ]}
            />
          </div>
          {mode === 'new' ? (
            <NewProject onDone={close} />
          ) : mode === 'clone' ? (
            <CloneProject onDone={close} />
          ) : (
            <>
              <div
                className={cx(s.drop, over && s.dropOver)}
                onDragOver={(e) => (e.preventDefault(), setOver(true))}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => (e.preventDefault(), setOver(false))}
              >
                <Icon name="folder" size={22} />
                <div className={s.dropText}>
                  <strong>Drop project folders here</strong>
                  <span>A git project, or a folder full of them (new ones in it show up too).</span>
                </div>
                {inApp() ? (
                  <Button variant="primary" onClick={() => void choose()}>
                    Choose Folders…
                  </Button>
                ) : null}
              </div>

              <div className={s.listHead}>
                <span>On {thisComputer()}</span>
                <input ref={filterBox} className={s.filter} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label={`Filter projects on ${thisComputer()}`} />
              </div>
              <div className={s.list} role="list">
                {found === undefined ? (
                  <div className={s.note}>Looking in your code folders…</div>
                ) : shown.length === 0 ? (
                  <div className={s.note}>{filter ? `Nothing called “${filter}”.` : 'No other git projects in ~/Projects, ~/Developer, ~/code and the like.'}</div>
                ) : (
                  shown.map((f) => {
                    const row = rows.get(f.path);
                    const done = row?.kind === 'added' || revealed.has(f.path);
                    const wasHidden = hiddenSet.has(f.path) || revealed.has(f.path);
                    const when = wasHidden ? 'hidden' : f.changed ? ago(f.changed) : undefined;
                    return (
                      <div key={f.path} className={s.item} role="listitem" onDoubleClick={() => !done && !row && void (wasHidden ? show(f.path) : add([f.path]))}>
                        <ProjectIcon id={`path:${f.path}`} name={f.name} size={26} />
                        <span className={s.itemText}>
                          <span className={s.itemName}>{f.name}</span>
                          {row?.kind === 'failed' ? (
                            <span className={s.itemError} role="alert">
                              {row.error}
                            </span>
                          ) : (
                            <span className={s.itemPath}>
                              {short(f.path)}
                              {when ? ` · ${when}` : ''}
                            </span>
                          )}
                        </span>
                        {row?.kind === 'adding' ? (
                          <span className={s.adding}>
                            <DotMatrix size={12} /> Adding…
                          </span>
                        ) : done ? (
                          <span className={s.added}>
                            <Icon name="check" size={12} /> {wasHidden ? 'Showing' : 'Added'}
                          </span>
                        ) : wasHidden ? (
                          <Button size="small" onClick={() => void show(f.path)} aria-label={`Show ${f.name}`}>
                            Show
                          </Button>
                        ) : (
                          <Button size="small" onClick={() => void add([f.path])}>
                            {row?.kind === 'failed' ? 'Try Again' : 'Add'}
                          </Button>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <form
                className={s.pathRow}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!typed.trim()) return;
                  void add([typed.trim()]);
                  setTyped('');
                }}
              >
                <input className={s.path} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type a path, like ~/code/app" aria-label="Folder path" spellCheck={false} />
                <Button size="small" type="submit" disabled={!typed.trim()}>
                  Add
                </Button>
                <span className={s.flex} />
                <Button variant={rows.size || revealed.size ? 'primary' : 'quiet'} onClick={close}>
                  {rows.size || revealed.size ? 'Done' : 'Cancel'}
                </Button>
              </form>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Start new: a name and where it goes; Beluga makes the folder, git and a first commit, then opens a worktree draft in it. */
function NewProject({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const actions = useActions();
  const home = useApp((st) => st.home);
  const [name, setName] = useState('');
  const [parent, setParent] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const nameBox = useRef<HTMLInputElement>(null);
  const short = (p: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  useEffect(() => {
    nameBox.current?.focus();
    void api.projects.newHome().then(
      (dir) => setParent((p) => p ?? dir),
      () => undefined,
    );
  }, []);

  const change = async (): Promise<void> => {
    const picked = await pickFolders('Where the new project goes');
    if (picked?.[0]) setParent(picked[0]);
  };

  const create = async (): Promise<void> => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const made = await api.projects.create(name.trim(), parent);
      onDone();
      // Its first task: describe what to build, and it gets a worktree of its own.
      actions.run({ type: 'new_worktree', projectId: made.id });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const where = parent ? `${short(parent).replace(/[\\/]+$/, '')}${sepOf(parent)}${name.trim() || 'name'}` : undefined;
  return (
    <form
      className={s.newForm}
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <label className={s.field}>
        <span>Name</span>
        <input ref={nameBox} className={s.nameInput} value={name} onChange={(e) => (setName(e.target.value), setError(undefined))} placeholder="my-app" aria-label="Project name" spellCheck={false} autoComplete="off" />
      </label>
      <div className={s.field}>
        <span>In</span>
        <div className={s.whereRow}>
          {inApp() ? (
            <>
              <span className={s.whereText}>
                <Icon name="folder" size={13} /> {parent ? short(parent) : 'Your code folder'}
              </span>
              <Button size="small" onClick={() => void change()}>
                Change…
              </Button>
            </>
          ) : (
            <input className={s.path} value={parent ? short(parent) : ''} onChange={(e) => setParent(e.target.value)} aria-label="Where the new project goes" spellCheck={false} />
          )}
        </div>
      </div>
      <p className={error ? s.newError : s.newNote} role={error ? 'alert' : undefined}>
        {error ?? (where ? `Makes ${where} with git and a first commit, ready for worktrees.` : 'Makes the folder with git and a first commit, ready for worktrees.')}
      </p>
      <div className={s.pathRow}>
        <span className={s.flex} />
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={!name.trim() || busy}>
          {busy ? 'Creating…' : 'Create Project'}
        </Button>
      </div>
    </form>
  );
}
