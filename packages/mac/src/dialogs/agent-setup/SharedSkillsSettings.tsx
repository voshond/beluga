import { useEffect, useState } from 'react';
import type { SharedSkill, SharedSkills, SkillLink } from '@beluga/shared/agent-setup.js';
import { Button, cx } from '../../components/ui.js';
import { toast, useBeluga } from '../../lib/beluga.js';
import { Group, Row } from '../settings-controls.js';
import s from '../settings.module.css';
import { SkillEditor } from './SkillEditor.js';
import a from './agent-setup.module.css';

type Editing = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly name: string };

const LINK_WORDS: Record<SkillLink, string> = {
  linked: 'linked',
  native: 'reads it',
  missing: 'not linked',
  other: 'has its own',
};

const LinkBadge = ({ agent, link }: { readonly agent: string; readonly link: SkillLink }) => (
  <span className={cx(a.badge, link === 'linked' || link === 'native' ? a.good : a.warn)}>
    {agent} {LINK_WORDS[link]}
  </span>
);

const needsRepair = (data: SharedSkills): boolean => Boolean(data.nestedLink) || data.skills.some((skill) => skill.claude === 'missing');

const SkillRow = ({ skill, onEdit }: { readonly skill: SharedSkill; readonly onEdit: () => void }) => (
  <Row label={skill.name} detail={skill.description}>
    <span className={a.badges}>
      <LinkBadge agent="Claude Code" link={skill.claude} />
      <LinkBadge agent="Codex" link={skill.codex} />
    </span>
    <Button size="small" variant="quiet" aria-label={`Edit ${skill.name}`} onClick={onEdit}>
      Edit
    </Button>
  </Row>
);

export const SharedSkillsSettings = () => {
  const { client } = useBeluga();
  const [data, setData] = useState<SharedSkills>();
  const [editing, setEditing] = useState<Editing>();

  const load = async () => setData(await client.api.agentSetup.skills());

  useEffect(() => {
    void load();
  }, []);

  const handleRepair = async () => {
    const result = await client.api.agentSetup.repairSkills();
    if ('error' in result) toast(client, result.error, 'error');
    await load();
  };

  const handleDone = (changed: boolean) => {
    setEditing(undefined);
    if (changed) void load();
  };

  return (
    <Group title="Shared skills">
      <Row label="Skills for Claude Code and Codex" detail={data ? `In ${data.root}. Codex reads this folder itself; Claude Code gets a link to each skill in its own skills folder.` : 'Looking…'}>
        {data && needsRepair(data) ? (
          <Button size="small" icon="link" onClick={() => void handleRepair()}>
            Repair Links
          </Button>
        ) : null}
        <Button size="small" icon="plus" disabled={editing !== undefined} onClick={() => setEditing({ kind: 'new' })}>
          New Skill
        </Button>
      </Row>
      {data?.nestedLink ? (
        <div className={s.note}>
          <code className={a.code}>{data.nestedLink}</code> links the whole folder one level too deep, so Claude Code doesn’t see these skills. Repair Links replaces it with one link per skill.
        </div>
      ) : null}
      {editing?.kind === 'new' ? <SkillEditor onDone={handleDone} /> : null}
      {data && data.skills.length === 0 && editing === undefined ? <div className={s.note}>No shared skills yet. New Skill makes one both agents can use.</div> : null}
      {data?.skills.map((skill) =>
        editing?.kind === 'edit' && editing.name === skill.name ? (
          <SkillEditor key={skill.name} name={skill.name} onDone={handleDone} />
        ) : (
          <SkillRow key={skill.name} skill={skill} onEdit={() => setEditing({ kind: 'edit', name: skill.name })} />
        ),
      )}
    </Group>
  );
};
