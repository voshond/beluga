import { joinPath } from '@beluga/shared/os-path.js';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { inApp } from '../lib/boot.js';
import { useApi } from '../lib/beluga.js';
import { pickFolders } from '../lib/projects.js';
import { useClock } from '../lib/window-active.js';
import s from './add-project.module.css';

export const CloneProject = ({ onDone }: { onDone: () => void }) => {
  const api = useApi();
  const actions = useActions();
  const [repositories, setRepositories] = useState<Awaited<ReturnType<typeof api.projects.github>>>();
  const [listError, setListError] = useState('');
  const [refreshing, setRefreshing] = useState(true);
  const [filter, setFilter] = useState('');
  const [home, setHome] = useState('');
  const [remote, setRemote] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void api.projects.githubCached().then((cached) => { if (cached) setRepositories((current) => current ?? cached.repos); }, () => undefined);
    void api.projects.github()
      .then(setRepositories, (err) => setListError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRefreshing(false));
    void api.projects.newHome().then(setHome, () => undefined);
  }, []);

  const shownRepositories = repositories?.filter((repo) => repo.name.toLowerCase().includes(filter.toLowerCase()));
  const listNote = !repositories ? (listError ? null : 'Loading GitHub repositories…') : shownRepositories?.length === 0 ? (refreshing ? 'Looking for more on GitHub…' : 'No repositories found.') : null;

  const tick = useClock(busy, 500);

  useEffect(() => {
    if (!busy) return;
    void api.projects.cloneProgress(target).then((value) => { if (value) setProgress(value); });
  }, [busy, target, tick]);

  const handleClone = async (): Promise<void> => {
    if (busy || !remote.trim() || !target.trim()) return;
    setBusy(true);
    setError('');
    setProgress('Starting clone…');
    try {
      const cloned = await api.projects.clone(remote.trim(), target.trim());
      onDone();
      actions.run({ type: 'new_worktree', projectId: cloned.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handleChoose = async (): Promise<void> => {
    const picked = await pickFolders('Choose an empty target folder');
    if (picked?.[0]) setTarget(picked[0]);
  };

  return (
    <form className={s.newForm} onSubmit={(event) => { event.preventDefault(); void handleClone(); }}>
      <div className={s.listHead}>
        <span>Your GitHub repositories</span>
        {repositories && refreshing ? <small className={s.listStatus} role="status">Updating…</small> : null}
        <input className={s.filter} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter" aria-label="Filter GitHub repositories" />
      </div>
      <div className={`${s.list} ${s.githubList}`} role="list">
        {listError ? <div className={s.note} role="alert">{repositories ? `Showing the last list. ${listError}` : `${listError} You can still enter a URL below.`}</div> : null}
        {listNote ? <div className={s.note}>{listNote}</div> : null}
        {shownRepositories?.map((repo) => (
          <div className={s.item} role="listitem" key={repo.name}>
            <span className={s.itemText}><span className={s.itemName}>{repo.name}</span><span className={s.itemPath}>{repo.private ? 'Private' : 'Public'}{repo.archived ? ' · Archived' : ''}</span></span>
            <Button size="small" disabled={busy} onClick={() => { setRemote(repo.url); if (home) setTarget(joinPath(home, repo.name.split('/').at(-1) || '')); setError(''); }}>Select</Button>
          </div>
        ))}
      </div>
      <label className={s.field}>
        <span>URL</span>
        <input className={s.nameInput} value={remote} onChange={(event) => setRemote(event.target.value)} placeholder="https://github.com/owner/repo.git" aria-label="GitHub repository URL" disabled={busy} spellCheck={false} />
      </label>
      <label className={s.field}>
        <span>Folder</span>
        <input className={s.nameInput} value={target} onChange={(event) => setTarget(event.target.value)} placeholder="~/code/repo" aria-label="Target folder" disabled={busy} spellCheck={false} />
        {inApp() ? <Button size="small" onClick={() => void handleChoose()} disabled={busy}>Choose…</Button> : null}
      </label>
      <p className={error ? s.newError : s.newNote} role={error ? 'alert' : 'status'}>{error || (busy ? progress : 'Choose a new or empty folder for the clone.')}</p>
      <div className={s.pathRow}>
        <span className={s.flex} />
        <Button variant="quiet" onClick={onDone} disabled={busy}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={busy || !remote.trim() || !target.trim()}>{busy ? 'Cloning…' : 'Clone Project'}</Button>
      </div>
    </form>
  );
};
