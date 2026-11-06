import { useEffect, useState } from 'react';
import { Button } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { pickFolders } from '../lib/projects.js';
import { Row } from './settings-controls.js';

/**
 * Settings › Workspaces › New projects go in: the folder new projects and clones start in (Add
 * projects › Start new, Clone). Unset, it's the first code folder found in your home. The folder
 * chosen is watched for projects too.
 */
export function ProjectsHomeRow() {
  const api = useApi();
  const saved = useApp((st) => st.prefs.projectsHome);
  const [current, setCurrent] = useState<string>();
  useEffect(() => {
    void api.projects.newHome().then(setCurrent, () => undefined);
  }, [api, saved]);
  const handleChoose = async (): Promise<void> => {
    const [dir] = (await pickFolders('New projects go in')) ?? [];
    if (dir) await api.projects.setHome(dir).catch(() => undefined);
  };
  const handleReset = (): void => void api.projects.setHome(null).catch(() => undefined);
  const detail = saved ? `${current ?? saved}. Its projects show in the sidebar too.` : `${current ?? '…'} (found on its own). Choose the folder you clone into.`;
  return (
    <Row label="New projects go in" detail={detail}>
      {saved ? (
        <Button onClick={handleReset} aria-label="Back to the folder found on its own">
          Default
        </Button>
      ) : null}
      <Button onClick={() => void handleChoose()} aria-label="Choose where new projects go">
        Choose…
      </Button>
    </Row>
  );
}
