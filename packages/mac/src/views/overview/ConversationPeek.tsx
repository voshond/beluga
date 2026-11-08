import * as Dialog from '@radix-ui/react-dialog';
import { useEffect } from 'react';
import { ChatLog } from '../../chat/ChatLog.js';
import { Alert } from '../../components/Alert.js';
import { Icon } from '../../components/Icon.js';
import { ProjectIcon } from '../../components/ProjectIcon.js';
import { Empty, cx } from '../../components/ui.js';
import { useApi } from '../../lib/beluga.js';
import { useThreadsChoice } from '../../dialogs/native/ThreadsChoice.js';
import type { ThreadChildren } from '@beluga/shared/threads.js';
import type { OverviewItem } from './overview-model.js';
import f from '../../components/form.module.css';
import s from './peek.module.css';
import { primaryKey } from '../../lib/shortcuts-model.js';

/**
 * Read an archived conversation without restoring it, like Quick Look: no message box, nothing
 * changes. Space or Esc closes it; Restore (Return) brings the workspace back.
 */
export function ConversationPeek({ item, onClose, onRestore, onDelete }: { item: OverviewItem; onClose: () => void; onRestore: () => void; onDelete: () => void }) {
  const api = useApi();
  const w = item.ws;
  useEffect(() => {
    void api.workspaces.load(w.id).catch(() => undefined);
  }, [api, w.id]);
  const where = item.project.root ? item.project.name : 'Chats';
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={s.peek}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-default]')?.focus();
          }}
          onKeyDown={(e) => {
            const onButton = (e.target as HTMLElement).tagName === 'BUTTON' && !(e.target as HTMLElement).hasAttribute('data-default');
            if (e.key === ' ' && !onButton) {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Enter' && !onButton && !primaryKey(e)) {
              e.preventDefault();
              onRestore();
            }
          }}
        >
          <header className={s.head}>
            <span className={s.icon} aria-hidden="true">
              {item.project.root ? <ProjectIcon id={item.project.id} name={item.project.name} size={28} /> : <Icon name="chat" size={18} />}
            </span>
            <div className={s.headText}>
              <Dialog.Title className={s.title}>
                {w.name}
                <span className={s.badge}>Archived</span>
              </Dialog.Title>
              <div className={s.subtitle}>
                {where}
                {w.branch ? (
                  <>
                    {' · branch '}
                    <code>{w.branch}</code>
                    {' kept'}
                  </>
                ) : null}
                {' · read only'}
              </div>
            </div>
            <button type="button" className={s.close} aria-label="Close" onClick={onClose}>
              <Icon name="x" size={12} />
            </button>
          </header>
          <div className={s.body}>
            <ChatLog channel={`ws:${w.id}`} empty={<Empty icon="chat" title="Nothing was said here" detail="This conversation has no messages." />} />
          </div>
          <footer className={s.buttons}>
            <button type="button" className={f.linkDanger} onClick={onDelete}>
              Delete Permanently…
            </button>
            <span className={s.flex} />
            <button type="button" className={f.button} onClick={onClose}>
              Done
            </button>
            <button type="button" data-default className={cx(f.button, f.default)} onClick={onRestore}>
              Restore
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** "Delete for good?" for an archived worktree or chat: red, and says exactly what goes. */
export function DeleteArchivedAlert({ item, onCancel, onDelete }: { item: OverviewItem; onCancel: () => void; onDelete: (children?: ThreadChildren) => void }) {
  const w = item.ws;
  const threads = useThreadsChoice(w.id, 'delete');
  const branch = w.kind === 'worktree' && w.branch && !w.external;
  return (
    <Alert
      icon="alert"
      tone="danger"
      title={`Delete “${w.name}” permanently?`}
      message={
        <>
          <p>
            {branch ? (
              <>
                This deletes its branch <code>{w.branch}</code> and the conversation. Commits that aren’t on another branch are lost.
              </>
            ) : (
              'This deletes the conversation and removes it from Beluga.'
            )}
          </p>
          <p>You can’t undo this.</p>
        </>
      }
      confirm={{ label: 'Delete', destructive: true, onClick: () => onDelete(threads.children) }}
      onCancel={onCancel}
    >
      {threads.box}
    </Alert>
  );
}
