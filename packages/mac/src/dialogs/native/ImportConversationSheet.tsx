import { underPart } from '@beluga/shared/path-inside.js';
import { useEffect, useMemo, useState } from 'react';
import type { OutsideConversation } from '@beluga/core/workspace-controller.js';
import { formatBytes } from '@beluga/shared/format.js';
import { Field, FormSheet, TextInput } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { Button, cx } from '../../components/ui.js';
import { tildePath } from '../../layout/outside-model.js';
import { useApi, useApp, useMachine } from '../../lib/beluga.js';
import { pickFolders } from '../../lib/projects.js';
import { agoText } from '../../views/project/home-model.js';
import s from './import-conversation.module.css';

/** The folder and branch name Beluga makes from a name (as the core's `slug` does). */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** More than this many, and the list gets a search field. */
const SEARCH_FROM = 8;

/** Where a conversation ran, said from the folder looked in ("" when it's that folder). */
function whereIn(dir: string, cwd: string, home: string): string {
  if (cwd === dir) return '';
  return underPart(dir, cwd) ?? tildePath(home, cwd);
}

/**
 * Import from Claude Code… (BLG-321): the conversations you had with Claude Code
 * outside Beluga (Terminal, an IDE, another app) in the project's folder or a folder inside it, or
 * in any folder you choose. Pick one and Claude goes on with it in a new worktree, remembering all
 * of it; the original stays as it was.
 */
export function ImportConversationSheet({ projectId, close }: { projectId: string; close: () => void }) {
  const api = useApi();
  // On a computer's page, its folders (BLG-793).
  const machine = useMachine();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const home = useApp((st) => st.home);
  const [dir, setDir] = useState<string>();
  const [found, setFound] = useState<{ dir: string; conversations: readonly OutsideConversation[] }>();
  const [picked, setPicked] = useState<string>();
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let live = true;
    setFound(undefined);
    api.workspaces
      .outsideConversations(projectId, dir)
      .then((r) => {
        if (!live) return;
        setFound(r);
        const first = r.conversations.find((c) => !c.wsId) ?? r.conversations[0];
        setPicked(first?.sessionId);
      })
      .catch(() => live && setFound({ dir: dir ?? project?.root ?? '', conversations: [] }));
    return () => {
      live = false;
    };
  }, [api, projectId, dir, project?.root]);
  const chosen = found?.conversations.find((c) => c.sessionId === picked);
  // The name follows the conversation you pick until you type one of your own.
  useEffect(() => {
    if (chosen && !named) setName(chosen.title);
  }, [chosen, named]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = found?.conversations ?? [];
    return q ? all.filter((c) => c.title.toLowerCase().includes(q) || c.cwd.toLowerCase().includes(q)) : all;
  }, [found, query]);
  if (!project) return null;
  const looking = found?.dir ?? dir ?? project.root;
  const opening = Boolean(chosen?.wsId);
  return (
    <FormSheet
      title="Import from Claude Code"
      icon="claude"
      intro={`Pick a conversation from Terminal or another app. Your agent goes on with it in a new worktree of ${project.name}.`}
      submitLabel={opening ? 'Open Its Worktree' : 'Continue in a Worktree'}
      canSubmit={Boolean(chosen) && (opening || Boolean(slug(name)))}
      onSubmit={() => {
        if (!chosen || !found) return;
        // The worktree's row and page show at once while it's made; a failure comes back as a toast.
        void api.workspaces.importOutside(projectId, found.dir, chosen.sessionId, opening ? undefined : name.trim()).catch(() => undefined);
        close();
      }}
      onCancel={close}
      width={580}
    >
      <Field
        label="From"
        aside={
          <Button
            size="small"
            variant="quiet"
            icon="folder"
            onClick={() =>
              void pickFolders('Choose a folder Claude Code ran in', { machine }).then((p) => {
                if (p?.[0]) setDir(p[0]);
              })
            }
          >
            Choose Another Folder…
          </Button>
        }
        hint="This folder and the folders inside it"
      >
        <span className={s.where} title={looking}>
          {tildePath(home, looking)}
        </span>
      </Field>
      {found && found.conversations.length > SEARCH_FROM ? <TextInput value={query} onChange={setQuery} placeholder="Search conversations" spellCheck={false} aria-label="Search conversations" /> : null}
      {/* Where the sheet's focus starts: the list, not the folder button (it loads after opening). */}
      <div className={s.focus} data-autofocus tabIndex={-1}>
        {!found ? (
          <p className={s.quiet}>Looking for conversations…</p>
        ) : !found.conversations.length ? (
          <p className={s.quiet}>No Claude Code conversation ran in this folder or inside it. Choose another folder, the one you started Claude in.</p>
        ) : (
          <ul className={s.list} role="radiogroup" aria-label="Claude Code conversations">
            {shown.map((c) => {
              const where = whereIn(found.dir, c.cwd, home);
              const on = c.sessionId === picked;
              return (
                <li key={c.sessionId}>
                  <button type="button" role="radio" aria-checked={on} className={cx(s.row, on && s.on)} onClick={() => setPicked(c.sessionId)}>
                    <Icon name={c.wsId ? 'branch' : 'chat'} size={14} className={s.icon} />
                    <span className={s.text}>
                      <span className={s.title}>{c.title}</span>
                      <span className={s.detail}>{[c.wsId ? 'Brought in already' : '', where, agoText(c.lastModified), formatBytes(c.bytes)].filter(Boolean).join(' · ')}</span>
                    </span>
                    {on ? <Icon name="check" size={13} className={s.check} /> : null}
                  </button>
                </li>
              );
            })}
            {!shown.length ? <li className={s.quiet}>Nothing matches “{query.trim()}”</li> : null}
          </ul>
        )}
      </div>
      {chosen && !opening ? (
        <Field label="Name" htmlFor="import-convo-name" hint={slug(name) ? <>Your branch <code>beluga/{slug(name)}</code>, from the commit that folder is on. Its uncommitted changes stay there.</> : undefined}>
          <TextInput
            id="import-convo-name"
            value={name}
            onChange={(v) => {
              setName(v);
              setNamed(true);
            }}
            maxLength={120}
            spellCheck={false}
          />
        </Field>
      ) : null}
    </FormSheet>
  );
}
