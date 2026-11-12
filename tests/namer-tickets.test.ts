import { describe, expect, it } from 'vitest';
import { nameTask, slugify, ticketKey } from '../src/agent/namer.js';
import { isOwnBranch, ticketBranch } from '../src/workspaces/manager.js';
import { buildPrPrompt } from '../src/workspaces/pr.js';
import type { CompletionRequest } from '../src/agent/runtime/types.js';

const PROMPT = 'work on ticket RUN-117 https://lendis.atlassian.net/browse/RUN-117';

const run = async (said: string | Error) => {
  const asked: CompletionRequest[] = [];
  const complete = async (req: CompletionRequest): Promise<string> => {
    asked.push(req);
    if (said instanceof Error) throw said;
    return said;
  };
  const name = await nameTask(PROMPT, { cwd: '/room', complete });
  return { name, asked };
};

describe('ticketKey', () => {
  it('finds a plain key', () => expect(ticketKey('fix RUN-117 now')).toBe('RUN-117'));
  it('finds a key only inside a url', () => expect(ticketKey('https://lendis.atlassian.net/browse/RUN-117')).toBe('RUN-117'));
  it('finds a key in a selectedIssue url', () => expect(ticketKey('https://x.atlassian.net/board?selectedIssue=RUN-117')).toBe('RUN-117'));
  it('returns undefined without a key', () => expect(ticketKey('fix the nav offset')).toBeUndefined());
  it('ignores a lowercase key', () => expect(ticketKey('fix run-117')).toBeUndefined());
  it('ignores standards that look like keys', () => expect(ticketKey('save the export as UTF-8 and hash it with SHA-256')).toBeUndefined());
  it('finds the key after a standard', () => expect(ticketKey('UTF-8 export for RUN-5')).toBe('RUN-5'));
  it('leaves a plain name alone when only a standard is mentioned', () => expect(slugify('convert the export to UTF-8')).toBe('convert-export-utf-8'));
});

describe('slugify with tickets', () => {
  it('uses only the key when nothing else says what the work is', () => expect(slugify(PROMPT)).toBe('run-117'));
  it('adds meaningful words after the key', () => expect(slugify('RUN-117 fix the FP navigation offset')).toBe('run-117-fix-fp-navigation'));
  it('does not leak url words', () => {
    const slug = slugify('https://example.com/some/page');
    expect(slug).not.toMatch(/https|com/);
  });
  it('keeps the old behaviour without a key', () => {
    expect(slugify('Please add a dark mode toggle to the settings page')).toBe('add-dark-mode-toggle');
    expect(slugify('???')).toMatch(/^task-[a-z0-9]{5}$/);
  });
});

describe('nameTask with tickets', () => {
  it('starts with the key when the model names the request', async () => {
    const { name } = await run('work-on-ticket-run-117');
    expect(name.startsWith('run-117')).toBe(true);
  });
  it('prefixes the key onto a model name without it', async () => expect((await run('fix-nav-offset')).name).toBe('run-117-fix-nav-offset'));
  it('falls back to the key when the model throws', async () => expect((await run(new Error('down'))).name).toBe('run-117'));
  it('never sends the url to the model', async () => {
    const { asked } = await run('fix-nav-offset');
    expect(asked[0]?.prompt).not.toContain('https://');
    expect(asked[0]?.prompt).toContain('RUN-117');
  });
});

describe('a ticket worktree’s branch and pull request', () => {
  it('branches as KEY/slug without repeating the key', () => expect(ticketBranch('RUN-117', 'run-117-fix-nav-offset')).toBe('RUN-117/fix-nav-offset'));
  it('never makes a bare key branch, which would block every other KEY/… branch', () => expect(ticketBranch('RUN-117', 'run-117')).toBe('RUN-117/work'));
  it('keeps a name without the key whole', () => expect(ticketBranch('RUN-117', 'mine')).toBe('RUN-117/mine'));
  it('knows its own ticket branch', () => {
    expect(isOwnBranch('RUN-117/fix-nav', 'fix-nav', 'beluga/', 'RUN-117')).toBe(true);
    expect(isOwnBranch('feature/fix-nav', 'other', 'beluga/', 'RUN-117')).toBe(false);
  });
  it('asks for the key at the start of the pull request title', () => {
    const ctx = { branch: 'RUN-117/fix-nav', base: 'origin/main', project: 'p' };
    expect(buildPrPrompt({ ...ctx, ticket: 'RUN-117' }, 'Open a PR')).toContain('start the pull request\'s title with "RUN-117: "');
    expect(buildPrPrompt(ctx, 'Open a PR')).toBe('Open a PR');
  });
});
