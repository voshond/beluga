import { useEffect, useState } from 'react';
import { Button } from '../components/ui.js';
import { inApp } from '../lib/boot.js';
import { useApi } from '../lib/beluga.js';
import { pickFolders } from '../lib/projects.js';
import s from './add-project.module.css';

export const CloneProject = ({ onDone }: { onDone: () => void }) => {
  const api = useApi();
  const [remote, setRemote] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      void api.projects.cloneProgress(target).then((value) => { if (value) setProgress(value); });
    }, 500);
    return () => window.clearInterval(timer);
  }, [busy, target]);

  const handleClone = async (): Promise<void> => {
    if (busy || !remote.trim() || !target.trim()) return;
    setBusy(true);
    setError('');
    setProgress('Starting clone…');
    try {
      await api.projects.clone(remote.trim(), target.trim());
      onDone();
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
