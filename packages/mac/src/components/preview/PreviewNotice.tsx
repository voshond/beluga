import { experimentOn } from '@beluga/shared/experiments.js';
import { parsePreviewRef, previewTitle } from '@beluga/shared/preview/ref.js';
import { webServed } from '../../lib/boot.js';
import { useApp, useBeluga } from '../../lib/beluga.js';
import { Icon } from '../Icon.js';
import { Button, cx } from '../ui.js';
import s from './preview.module.css';

/**
 * What a preview block shows where it won't draw (Live previews off, a friend's answer, outside a
 * worktree, a browser): a quiet card. Small on purpose: the chat shows it without loading any of
 * the previews themselves (PreviewBlock.tsx loads only when one can draw).
 */

/** A quiet card in the preview's place. */
export function Notice({ title, icon = 'eye', detail, action }: { title: string; icon?: 'eye' | 'info' | 'lock'; detail: string; action?: { label: string; run: () => void } }) {
  return (
    <figure className={cx(s.preview, s.notice)}>
      <Icon name={icon} size={13} />
      <div className={s.noticeText}>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {action ? (
        <Button size="small" onClick={action.run}>
          {action.label}
        </Button>
      ) : null}
    </figure>
  );
}

/** Whether a block can draw here: on, your own agent's, in a worktree's conversation, in the app. */
export function usePreviewHere(local: boolean): { readonly draws: boolean; readonly wsId: string | undefined; readonly on: boolean } {
  const on = useApp((st) => experimentOn(st.prefs.experiments, 'previews'));
  const wsId = useApp((st) => (st.view.kind === 'workspace' ? st.view.id : undefined));
  return { draws: on && local && Boolean(wsId) && !webServed(), wsId, on };
}

/** The card for a block that can't draw here, saying why (and Turn On… when it's only off). */
export function PreviewNotice({ code, local }: { code: string; local: boolean }) {
  const { ui } = useBeluga();
  const { wsId, on } = usePreviewHere(local);
  const ref = parsePreviewRef(code);
  if (!ref) return <Notice icon="info" title="This preview can’t be read" detail="Its first line should be a component file, an .html file, or a page on this computer." />;
  const title = previewTitle(ref);
  if (!local) return <Notice icon="lock" title={`A preview of ${title}`} detail="Previews run only for your own agent’s answers, on your own computer." />;
  if (webServed()) return <Notice title={`A preview of ${title}`} detail="Live previews show in the Beluga app on the computer that runs them." />;
  if (!wsId) return <Notice title={`A preview of ${title}`} detail="It shows in its worktree’s conversation." />;
  if (!on) return <Notice title={`A preview of ${title}`} detail="Live previews are an experimental feature, off until you turn them on." action={{ label: 'Turn On…', run: () => ui.patch({ settings: 'experimental' }) }} />;
  return null;
}
