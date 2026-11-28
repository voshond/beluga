import { DotMatrix } from '../components/DotMatrix.js';
import type { IconName } from '../components/Icon.js';
import { Button, Empty, EmptyActions } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useProjectsState } from '../lib/projects-state.js';

/** What a sheet or a line says while the projects are on their way. */
export const LOADING_PROJECTS = 'Loading your projects…';

/**
 * A page while Beluga is still finding your projects (it just started): calm, and no "add a
 * project", since yours are on their way. Nothing at all in the first moments (`pending`).
 */
export function ProjectsLoading({ icon, pending }: { icon: IconName; pending?: boolean }) {
  if (pending) return null;
  return (
    <div role="status" style={{ display: 'contents' }}>
      <Empty icon={icon} mark={<DotMatrix size={18} />} title={LOADING_PROJECTS} />
    </div>
  );
}

/**
 * A Work page before any project is added: what it needs, and the button that adds one (the
 * sidebar's own "Add a project…"). While the projects are still loading, it says that instead.
 */
export function NoProjects({ icon, detail }: { icon: IconName; detail: string }) {
  const actions = useActions();
  const projects = useProjectsState();
  if (projects === 'loading' || projects === 'pending') return <ProjectsLoading icon={icon} pending={projects === 'pending'} />;
  return (
    <Empty
      icon={icon}
      title="No projects yet"
      detail={detail}
      action={
        <EmptyActions>
          <Button size="large" variant="primary" icon="plus" onClick={() => actions.run({ type: 'add_project' })}>
            Add a Project…
          </Button>
        </EmptyActions>
      }
    />
  );
}
