import { useEffect, useState } from 'react';
import type { Artifact, ArtifactRead } from '@beluga/core/initiatives/model.js';
import { Markdown } from '../chat/Markdown.js';
import { FormSheet } from '../components/FormSheet.js';
import { Button } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { copyText } from '../lib/copy.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

const PathBody = ({ path }: { path: string }) => {
  const a = useInitiativeActions();
  const handleCopy = (): void => void a.act(() => copyText(path), 'Copied the path');
  return (
    <div className={s.artifactPath}>
      <span className={s.quiet}>This file can't be shown here. It is on the daemon's computer at:</span>
      <code className={s.code}>{path}</code>
      <span>
        <Button size="small" icon="copy" onClick={handleCopy}>
          Copy Path
        </Button>
      </span>
    </div>
  );
};

const ArtifactBody = ({ read }: { read: ArtifactRead }) => {
  if (read.kind === 'other') return <PathBody path={read.path} />;
  if (read.kind === 'image') return <img className={s.artifactImage} src={`data:${read.mediaType};base64,${read.data}`} alt={read.name} />;
  return (
    <>
      {read.name.toLowerCase().endsWith('.md') ? <Markdown text={read.text} /> : <pre className={s.code}>{read.text}</pre>}
      {read.cut ? <p className={s.quiet}>Only the start is shown: the file is longer.</p> : null}
    </>
  );
};

export const ArtifactSheet = ({ slug, artifact, close }: { slug: string; artifact: Artifact; close: () => void }) => {
  const api = useApi();
  const [read, setRead] = useState<ArtifactRead>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    api.initiatives.readArtifact(slug, artifact.id).then(
      (r) => alive && setRead(r),
      (err: Error) => alive && setError(err.message),
    );
    return () => {
      alive = false;
    };
  }, [api, slug, artifact.id]);
  return (
    <FormSheet title={artifact.title} icon="fileText" submitLabel="Done" hideSubmit cancelLabel="Done" width={720} onCancel={close} onSubmit={close}>
      <div className={s.reader}>
        {artifact.why ? <p className={s.quiet}>{artifact.why}</p> : null}
        {error ? <span className={s.trouble}>{error}</span> : read ? <ArtifactBody read={read} /> : <span className={s.quiet}>Reading…</span>}
      </div>
    </FormSheet>
  );
};
