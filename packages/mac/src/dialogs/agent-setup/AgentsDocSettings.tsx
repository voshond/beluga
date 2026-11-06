import { useEffect, useState } from 'react';
import type { AgentsDoc, DocLink, DocLinkState } from '@beluga/shared/agent-setup.js';
import { Button, cx } from '../../components/ui.js';
import { toast, useBeluga } from '../../lib/beluga.js';
import { Group, Row } from '../settings-controls.js';
import a from './agent-setup.module.css';

type DocRuntime = 'claude' | 'codex';

const AGENT_NAMES: Record<DocRuntime, string> = { claude: 'Claude Code', codex: 'Codex' };

const LINK_DETAIL: Record<DocLink, (link: DocLinkState) => string> = {
  linked: (link) => `${link.path} points here.`,
  missing: (link) => `${link.path} doesn’t exist yet.`,
  file: (link) => `${link.path} is a file of its own. Linking keeps a backup of it next to it.`,
  elsewhere: (link) => `${link.path} points at ${link.target ?? 'another file'}. Linking keeps that link as a backup.`,
};

const DocLinkRow = ({ runtime, label, link, onLink }: { readonly runtime: DocRuntime; readonly label: string; readonly link: DocLinkState; readonly onLink: () => void }) => (
  <Row label={label} detail={LINK_DETAIL[link.state](link)}>
    {link.state === 'linked' ? (
      <span className={cx(a.badge, a.good)}>Linked</span>
    ) : (
      <Button size="small" icon="link" aria-label={`Link ${AGENT_NAMES[runtime]} to AGENTS.md`} onClick={onLink}>
        Link
      </Button>
    )}
  </Row>
);

export const AgentsDocSettings = () => {
  const { client } = useBeluga();
  const [doc, setDoc] = useState<AgentsDoc>();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();

  const load = async () => {
    const found = await client.api.agentSetup.agentsDoc();
    setDoc(found);
    setText(found.text);
  };

  useEffect(() => {
    void load();
  }, []);

  const handleSave = async () => {
    const result = await client.api.agentSetup.saveAgentsDoc(text);
    if ('error' in result) return setError(result.error);
    setError(undefined);
    toast(client, 'Saved AGENTS.md. New runs read it.', 'success');
    await load();
  };

  const handleLink = async (runtime: DocRuntime) => {
    const result = await client.api.agentSetup.linkAgentsDoc(runtime);
    if ('error' in result) toast(client, result.error, 'error');
    if ('backup' in result && result.backup) toast(client, `Kept the old one as ${result.backup}`, 'info');
    await load();
  };

  const dirty = doc !== undefined && text !== doc.text;

  return (
    <Group title="Global AGENTS.md">
      <Row label="Instructions for every project" detail={doc ? `${doc.path}: Claude Code and Codex read it on your own runs, never a friend’s.` : 'Looking…'}>
        <Button size="small" variant="primary" disabled={!dirty} onClick={() => void handleSave()}>
          Save
        </Button>
      </Row>
      <div className={a.editor}>
        <textarea className={`${a.textarea} ${a.tall}`} aria-label="Global AGENTS.md" spellCheck={false} disabled={doc === undefined} placeholder="How you like to work, conventions, tools you use…" value={text} onChange={(e) => setText(e.target.value)} />
        {error ? <span className={a.error}>{error}</span> : null}
      </div>
      {doc ? (
        <>
          <DocLinkRow runtime="claude" label="Claude Code reads it" link={doc.claude} onLink={() => void handleLink('claude')} />
          <DocLinkRow runtime="codex" label="Codex reads it" link={doc.codex} onLink={() => void handleLink('codex')} />
        </>
      ) : null}
    </Group>
  );
};
