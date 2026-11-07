import { describe, expect, it } from 'vitest';
import { taskInput } from '../src/agent/plan-tools.js';
import { buildSystemAppend } from '../src/agent/prompt.js';
import { waitingNeeds } from '../src/companion/needs-you.js';
import { askQid, askQuestion, decisionQid, decisionQuestion, runMarkdown } from '../src/core/plans/decisions.js';
import { normalizeBody } from '../src/core/plans/edit.js';
import { type PlanTask, runOf } from '../src/core/plans/model.js';
import type { TaskView } from '../src/core/plans/progress.js';
import { initialState } from '../src/core/store.js';

/** A task the user runs themselves (sudo, a deploy): the card carries the exact commands, never just "done?". */

const DEPLOY = { on: 'i9arch', cwd: '/home/voshond/.beluga/workspaces/cd/deploy', commands: ['git merge origin/pr-4 origin/pr-5', 'sudo ./install.sh'], expect: 'install.sh ends with "enabled and started"' };

const viewOf = (task: PlanTask): TaskView => ({ task, milestoneId: 'm1', state: 'ready', waitsOn: [], forYou: true });

describe('the commands a task of yours needs', () => {
  it('are trimmed and capped, and none without a command', () => {
    expect(runOf(undefined)).toBeUndefined();
    expect(runOf({ on: 'i9arch', commands: ['  ', ''] })).toBeUndefined();
    expect(runOf({ on: '  the   NAS ', commands: 'docker compose pull\n\ndocker compose up -d  ', expect: ' ' })).toEqual({ on: 'the NAS', commands: ['docker compose pull', 'docker compose up -d'] });
    expect(runOf({ commands: Array.from({ length: 30 }, (_, i) => `echo ${i}`) })!.commands).toHaveLength(12);
  });

  it('show where, a block to paste that starts in its folder, and how you tell it worked', () => {
    const text = runMarkdown({ ...DEPLOY, cwd: '/home/me/my repo' });
    expect(text).toContain('Run on **i9arch**:');
    expect(text).not.toContain('in `/home/me/my repo`');
    expect(text).toContain("```sh\ncd '/home/me/my repo'\ngit merge origin/pr-4 origin/pr-5\nsudo ./install.sh\n```");
    expect(text).toContain('It worked when: install.sh ends with "enabled and started"');
  });

  it('are kept when the plan is written, and only on a task for you', () => {
    const body = normalizeBody({
      title: 'Ship',
      goal: 'Deploy',
      milestones: [{ title: 'Go', tasks: [taskInput({ id: 'deploy', title: 'Deploy on i9arch', assignee: 'me', decision: { question: 'Deployed?', options: [], run: DEPLOY } }) as PlanTask, { id: 'code', title: 'Code', acceptance: [], blockedBy: [], decision: { question: 'x', options: [], run: DEPLOY } }] }],
    });
    const [deploy, code] = body.milestones[0]!.tasks;
    expect(deploy!.decision!.run).toEqual(DEPLOY);
    expect(code!.decision).toBeUndefined();
  });

  it('go on the decision card, with Done / It failed when the plan gave no options', () => {
    const task: PlanTask = { id: 'deploy', title: 'Merge #4 and #5 and deploy on i9arch', acceptance: [], blockedBy: [], assignee: 'me', decision: { question: 'Merged and deployed?', options: [], run: DEPLOY } };
    const q = decisionQuestion(viewOf(task)).questions[0]!;
    expect(q.question).toContain('Merged and deployed?');
    expect(q.question).toContain('```sh\ncd /home/voshond/.beluga/workspaces/cd/deploy\ngit merge');
    expect(q.options.map((o) => o.label)).toEqual(['Done', 'It failed']);
    expect(q.options[0]!.description).toContain('enabled and started');
  });

  it('keep their place on a card whose words run long: the words are cut, not the commands', () => {
    const task: PlanTask = { id: 'deploy', title: 'Deploy', goal: 'x'.repeat(3000), acceptance: [], blockedBy: [], assignee: 'me', decision: { question: 'Done?', options: [{ label: 'Yes' }], run: DEPLOY } };
    const q = decisionQuestion(viewOf(task)).questions[0]!;
    expect(q.question.length).toBeLessThanOrEqual(1000);
    expect(q.question).toContain('sudo ./install.sh\n```');
  });

  it('go on a question a task’s agent asks', () => {
    const q = askQuestion({ task: 'deploy', question: 'Can you run the installer?', options: [{ label: 'Done' }, { label: 'Failed' }], run: runOf(DEPLOY), worktree: 'w1', at: 1 }, 'CD-73', 'Deploy').questions[0]!;
    expect(q.question).toContain('sudo ./install.sh');
  });

  it('reach the phone line for line, not flattened into the title', () => {
    const task: PlanTask = { id: 'deploy', title: 'Deploy', acceptance: [], blockedBy: [], assignee: 'me', decision: { question: 'Deployed?', options: [], run: DEPLOY } };
    const question = decisionQuestion(viewOf(task));
    const state = { ...initialState('me'), questions: [{ qid: decisionQid('pl_1', 'deploy'), requestId: 'r1', owner: 'me', channel: 'room', picked: {}, question }] };
    const card = waitingNeeds(state).find((n) => n.id === `question:${decisionQid('pl_1', 'deploy')}`)!;
    expect(card.detail).toBe('cd /home/voshond/.beluga/workspaces/cd/deploy\ngit merge origin/pr-4 origin/pr-5\nsudo ./install.sh');
    expect(askQid('pl_1', 'deploy', 1)).toMatch(/^ask:/);
  });

  it('are what every agent is told to give when it needs you to run something', () => {
    expect(buildSystemAppend('kay')).toContain('never just ask whether it is done: give the exact commands');
  });
});
