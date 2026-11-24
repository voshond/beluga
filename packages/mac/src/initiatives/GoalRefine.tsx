import { useRef, useState } from 'react';
import type { GoalRefine, InitiativeView } from '@beluga/core/initiatives/model.js';
import { Markdown } from '../chat/Markdown.js';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { Section } from './InitiativeParts.js';
import { useInitiativeActions } from './use-initiatives.js';
import s from './initiatives.module.css';

type RefineState = { readonly kind: 'idle' } | { readonly kind: 'working' } | { readonly kind: 'draft'; readonly goal: string } | { readonly kind: 'error'; readonly message: string };

export type Refine = {
  readonly state: RefineState;
  readonly start: () => void;
  readonly clear: () => void;
};

export const useGoalRefine = (input: GoalRefine): Refine => {
  const api = useApi();
  const [state, setState] = useState<RefineState>({ kind: 'idle' });
  const run = useRef(0);
  const start = (): void => {
    run.current += 1;
    const mine = run.current;
    setState({ kind: 'working' });
    api.initiatives.refineGoal(input).then(
      (made) => mine === run.current && setState({ kind: 'draft', goal: made.goal }),
      (err: Error) => mine === run.current && setState({ kind: 'error', message: err.message.replace(/^Error: /, '') }),
    );
  };
  const clear = (): void => {
    run.current += 1;
    setState({ kind: 'idle' });
  };
  return { state, start, clear };
};

export const RefineButton = ({ refine, disabled }: { refine: Refine; disabled?: boolean }) => (
  <Button size="small" icon="sparkles" onClick={refine.start} disabled={disabled || refine.state.kind === 'working'} aria-label="Refine the goal with your agent">
    {refine.state.kind === 'working' ? 'Refining…' : 'Refine With Agent'}
  </Button>
);

export const GoalDraft = ({ refine, onUse }: { refine: Refine; onUse: (goal: string) => void }) => {
  const { state } = refine;
  if (state.kind === 'idle') return null;
  if (state.kind === 'working')
    return (
      <div className={s.draft} role="status" data-refine="working">
        <span className={s.quiet}>Your agent is reading the epic and drafting a goal. This can take a minute.</span>
        <span className={s.buttons}>
          <Button size="small" variant="quiet" onClick={refine.clear}>
            Stop
          </Button>
        </span>
      </div>
    );
  if (state.kind === 'error')
    return (
      <div className={s.trouble} role="alert" data-refine="error">
        <Icon name="alert" size={12} />
        {state.message}
      </div>
    );
  const handleUse = (): void => {
    onUse(state.goal);
    refine.clear();
  };
  return (
    <div className={s.draft} data-refine="draft" aria-label="The agent’s draft of the goal">
      <div className={s.draftBody}>
        <Markdown text={state.goal} />
      </div>
      <span className={s.buttons}>
        <Button size="small" variant="primary" onClick={handleUse}>
          Use This
        </Button>
        <Button size="small" variant="quiet" onClick={refine.clear}>
          Keep Mine
        </Button>
      </span>
    </div>
  );
};

export const GoalSection = ({ item }: { item: InitiativeView }) => {
  const a = useInitiativeActions();
  const refine = useGoalRefine({ name: item.name, goal: item.goal, epics: [...item.epics] });
  const handleUse = (goal: string): void => void a.act(() => a.update(item.slug, { goal }), 'Saved the goal');
  return (
    <Section title="Goal" aside={<RefineButton refine={refine} disabled={Boolean(item.trouble)} />}>
      {item.goal ? (
        <div className={s.goal}>
          <Markdown text={item.goal} />
        </div>
      ) : (
        <p className={s.lede}>Not written down yet: Edit… to add it, or let your agent draft it from the epic.</p>
      )}
      <GoalDraft refine={refine} onUse={handleUse} />
    </Section>
  );
};
