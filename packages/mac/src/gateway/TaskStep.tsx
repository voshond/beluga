import { Icon } from '../components/Icon.js';
import { iconOf } from '../chat/steps/StepRow.js';
import { taskStepLine } from './step-line.js';

/** One step of a friend's task: a line with its tool's icon, never a chevron (there is nothing to open). */
export function TaskStep({ line, owner, className }: { line: string; owner?: string | undefined; className?: string | undefined }) {
  const step = taskStepLine(line, owner);
  return (
    <div className={className} title={step.full}>
      <Icon name={step.asked ? 'lock' : iconOf({ kind: 'tool', ...(step.tool ? { tool: step.tool } : {}) })} size={11} />
      <span>{step.words}</span>
    </div>
  );
}
