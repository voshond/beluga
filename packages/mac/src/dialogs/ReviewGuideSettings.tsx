import { useEffect, useState } from 'react';
import { formatBytes } from '@beluga/shared/format.js';
import { TextArea } from '../components/FormSheet.js';
import { Button } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { Group, Row } from './settings-controls.js';
import r from './review-guide.module.css';

type Guide = {
  readonly info?: { readonly updatedAt: number; readonly size: number; readonly brief: boolean };
  readonly prompt: string;
  readonly custom: boolean;
};

/**
 * A project's review guide (docs/review-guide.md): kept in Beluga, written by your agent from the
 * project's pull request reviews with the prompt below. Every pull request your agent opens there is
 * checked against it first, and every run there gets its brief.
 */
export function ReviewGuideSettings({ projectId, close }: { projectId: string; close: () => void }) {
  const api = useApi();
  const [guide, setGuide] = useState<Guide>();
  const [prompt, setPrompt] = useState('');
  const load = (): void =>
    void api.workbench.reviewGuide(projectId).then((g) => {
      if (!g) return;
      setGuide(g);
      setPrompt(g.prompt);
    });
  useEffect(load, [projectId]);
  if (!guide) return null;

  const edited = prompt.trim() !== guide.prompt.trim();
  const savePrompt = async (): Promise<void> => {
    if (edited) await api.workbench.setReviewGuidePrompt(projectId, prompt);
  };
  const handleSave = (): void => void savePrompt().then(load);
  const handleReset = (): void => void api.workbench.setReviewGuidePrompt(projectId, '').then(load);
  const handleGenerate = (): void => {
    void savePrompt().then(() => api.workbench.generateReviewGuide(projectId));
    close();
  };
  const handleRemove = (): void => void api.workbench.removeReviewGuide(projectId).then(load);
  const info = guide.info;

  return (
    <>
      <Group title="Review guide">
        <Row
          label={info ? 'Guide' : 'No guide yet'}
          detail={
            info
              ? `Updated ${new Date(info.updatedAt).toLocaleString()} · ${formatBytes(info.size)}${info.brief ? '' : ' · no brief for agents'}`
              : 'Generate has your agent write it from the project’s pull request reviews, in a chat of its own.'
          }
        >
          <div className={r.actions}>
            {info ? <Button onClick={() => void api.workbench.openReviewGuide(projectId)}>Open</Button> : null}
            {info ? (
              <Button variant="danger" onClick={handleRemove}>
                Remove
              </Button>
            ) : null}
            <Button variant="primary" onClick={handleGenerate}>
              {info ? 'Regenerate' : 'Generate'}
            </Button>
          </div>
        </Row>
        <Row label="What it does" detail="Every pull request your agent opens here is checked against it first (Create PR goes through your agent), and every run here gets its brief. Kept in Beluga, never in the repository." />
      </Group>
      <Group title="How it’s written">
        <div className={r.prompt}>
          <TextArea value={prompt} onChange={setPrompt} mono rows={14} aria-label="The prompt your agent writes the review guide with" />
          <div className={r.actions}>
            {guide.custom ? <Button onClick={handleReset}>Use the Built-in Prompt</Button> : null}
            <Button disabled={!edited} onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      </Group>
    </>
  );
}
