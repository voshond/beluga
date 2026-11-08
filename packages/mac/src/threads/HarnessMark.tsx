import type { Workspace } from '@beluga/workspaces/types.js';
import { Icon } from '../components/Icon.js';
import { agentName } from '../lib/agent-words.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import s from '../layout/Sidebar.module.css';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { harnessOf } from './threads-model.js';

/** Which agent runs a chat, at a sidebar row's edge, in one quiet tone: one width whatever the row says. Nothing with threads off, or when every chat listed runs one harness. */
export function HarnessMark({ ws }: { ws: Pick<Workspace, 'agent' | 'kind'> }) {
  const harness = useApp((state) => harnessOf(state, ws), sameDeep);
  if (!harness) return null;
  return (
    <span className={s.harnessMark} title={agentName(harness)} data-harness={harness.runtime}>
      <Icon name={agentMark(harness)} size={12} fill="currentColor" />
    </span>
  );
}
