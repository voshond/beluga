import { describe, expect, it } from 'vitest';
import { isJiraServer, jiraReadVerdict, parseGoal, refineGoal, refinePrompt } from '../src/agent/goal-refiner.js';
import { CompletionError, type CompletionRequest } from '../src/agent/runtime/types.js';

describe('refining an initiative’s goal', () => {
  it('asks with the name, the epics and what was typed', () => {
    const prompt = refinePrompt({ name: 'Checkout v2', goal: '  ship the checkout  ', epics: ['SHOP-120', 'SHOP-121'] });
    expect(prompt).toContain('Initiative: Checkout v2');
    expect(prompt).toContain('Jira epics: SHOP-120, SHOP-121');
    expect(prompt).toContain('"""\nship the checkout\n"""');
    expect(refinePrompt({ name: '', goal: '', epics: [] })).toBe('Jira epics: none linked\n\nThey typed no goal yet: draft it from the epics.\n\nWrite the goal.');
  });

  it('mounts only your Jira server, and lets it read and nothing else', async () => {
    const seen: CompletionRequest[] = [];
    const goal = await refineGoal(
      { name: 'A', goal: 'ship', epics: ['SHOP-120'] },
      {
        cwd: '/tmp',
        complete: async (req) => {
          seen.push(req);
          return 'Ship the checkout to every market.\n\n## Scope\n\n- cards';
        },
      },
    );
    expect(goal).toBe('Ship the checkout to every market.\n\n## Scope\n\n- cards');
    const req = seen[0]!;
    expect(req.tools).toBeUndefined();
    expect(req.suites).toBeUndefined();
    expect(req.system).toContain('Reply with only the goal, in Markdown');
    expect(req.system).toContain('## Open questions');
    expect(['jira', 'mcp-atlassian', 'slack', 'calendar'].map((name) => req.ownerMcp!(name))).toEqual([true, true, false, false]);
    expect(req.vetTool!('mcp__jira__jira_get_issue', {}).allow).toBe(true);
    expect(req.vetTool!('mcp__jira__jira_add_comment', {}).allow).toBe(false);
    expect(req.maxTurns).toBeGreaterThan(1);
  });

  it('takes one turn when there is no epic to read', async () => {
    const seen: CompletionRequest[] = [];
    await refineGoal({ name: 'A', goal: 'ship', epics: [] }, { cwd: '/tmp', complete: async (req) => (seen.push(req), 'Ship the thing to everyone, soon.') });
    expect(seen[0]!.maxTurns).toBe(1);
  });

  it('allows Jira reads only', () => {
    const allowed = ['mcp__jira__jira_get_issue', 'mcp__jira__jira_search', 'mcp__jira__jira_get_project_issues', 'mcp__mcp-atlassian__jira_get_issue', 'mcp__atlassian__getJiraIssue', 'mcp__atlassian__searchJiraIssuesUsingJql'];
    const denied = ['mcp__jira__jira_add_comment', 'mcp__jira__jira_update_issue', 'mcp__jira__jira_transition_issue', 'mcp__jira__jira_create_issue', 'mcp__jira__jira_delete_issue', 'mcp__jira__jira_get_transitions', 'mcp__jira__jira_download_attachments', 'mcp__slack__slack_read_thread', 'Bash', 'Read', 'Write', 'mcp__atlassian__editJiraIssue'];
    expect(allowed.filter((tool) => !jiraReadVerdict(tool).allow)).toEqual([]);
    expect(denied.filter((tool) => jiraReadVerdict(tool).allow)).toEqual([]);
    expect(isJiraServer('Atlassian')).toBe(true);
  });

  it('keeps only the Markdown: no fence, nothing too short, never past the goal’s cap', () => {
    expect(parseGoal('```markdown\nShip the checkout to every market.\n```')).toBe('Ship the checkout to every market.');
    expect(parseGoal('  ok  ')).toBeUndefined();
    expect(parseGoal('x'.repeat(20_000))).toHaveLength(12_000);
  });

  it('has no draft when the agent says nothing useful, and fails when the call does', async () => {
    expect(await refineGoal({ name: 'A', goal: 'ship', epics: [] }, { cwd: '/tmp', complete: async () => '' })).toBeUndefined();
    const failing = refineGoal({ name: 'A', goal: 'ship', epics: [] }, { cwd: '/tmp', complete: async () => Promise.reject(new CompletionError('failed')) });
    await expect(failing).rejects.toThrow(/could not answer/);
  });
});
