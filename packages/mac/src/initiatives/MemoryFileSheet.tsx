import { useEffect, useState } from 'react';
import { Markdown } from '../chat/Markdown.js';
import { FormSheet } from '../components/FormSheet.js';
import { useApi } from '../lib/beluga.js';
import s from './initiatives.module.css';

type Read = { readonly name: string; readonly text: string; readonly cut: boolean };

export const MemoryFileSheet = ({ slug, file, close }: { slug: string; file: string; close: () => void }) => {
  const api = useApi();
  const [read, setRead] = useState<Read>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    api.initiatives.readFile(slug, file).then(
      (r) => alive && setRead(r),
      (err: Error) => alive && setError(err.message),
    );
    return () => {
      alive = false;
    };
  }, [api, slug, file]);
  const markdown = file.endsWith('.md');
  const body = error ? <span className={s.trouble}>{error}</span> : !read ? <span className={s.quiet}>Reading…</span> : markdown ? <Markdown text={read.text} /> : <pre className={s.code}>{read.text}</pre>;
  return (
    <FormSheet title={file} icon="fileText" submitLabel="Done" hideSubmit cancelLabel="Done" width={720} onCancel={close} onSubmit={close}>
      <div className={s.reader}>
        {body}
        {read?.cut ? <p className={s.quiet}>Only the start is shown: the file is longer.</p> : null}
      </div>
    </FormSheet>
  );
};
