import { describe, expect, it } from 'vitest';
import { Store, initialState } from '../src/core/store.js';
import { API } from '../src/ipc/api.js';
import { apiProxy, type BelugaClient } from '../src/ipc/client.js';
import { submitTyped, worktreeMode } from '../src/ui/submit.js';
import { screenOver } from './helpers.js';

describe('the first worktree message', () => {
  it.each([
    [true, false, { plan: true }],
    [true, true, { terminal: true, plan: true }],
    [false, false, undefined],
    [false, true, { terminal: true }],
  ])('sends the selected Plan mode through startWorktree (plan: %s, terminal: %s)', (plan, terminal, options) => {
    const domain = new Store(initialState('room'));
    if (plan) domain.dispatch({ type: 'plan_mode', channel: 'draft', on: true });
    const { screen } = screenOver(domain);
    screen.dispatch({ type: 'view', view: { kind: 'draft_worktree', projectId: 'proj', back: { kind: 'overview' } } });
    const calls: Array<{ method: string; args: readonly unknown[] }> = [];
    const api = apiProxy(async (method, args) => {
      calls.push({ method, args });
    });
    submitTyped({ client: { store: screen, api } as BelugaClient, ui: () => ({}), patchUi: () => undefined, runUiAction: () => undefined, toTerminal: () => terminal }, 'Fix the bug');
    expect(calls).toEqual([{ method: 'workspaces.startWorktree', args: ['proj', 'Fix the bug', options] }]);
  });

  it.each([
    [{ terminal: false, plan: false, tasks: true }, { tasks: true }],
    // Planned in the chat: never its terminal, and no plan mode on top (a plan's own conversation has none).
    [{ terminal: true, plan: true, tasks: true }, { tasks: true }],
    [{ terminal: true, plan: true, tasks: false }, { terminal: true, plan: true }],
    [{ terminal: false, plan: false, tasks: false }, {}],
  ])('the picked mode %o starts the worktree with %o', (picked, options) => {
    expect(worktreeMode(picked)).toEqual(options);
    expect(API['workspaces.startWorktree'].args.parse(['proj', 'Build refunds', options])[2]).toEqual(options);
  });
});
