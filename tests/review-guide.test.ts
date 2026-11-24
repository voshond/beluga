import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { instructionPieces } from '../src/agent/run-instructions.js';
import { Store, initialState } from '../src/core/store.js';
import type { WorkspaceController } from '../src/core/workspace-controller.js';
import { Workbench } from '../src/core/workbench.js';
import { buildPrPrompt } from '../src/workspaces/pr.js';
import {
  DEFAULT_REVIEW_GUIDE_PROMPT,
  GUIDE_PATH_MARK,
  buildReviewGuideAppend,
  customReviewGuidePrompt,
  ensureReviewGuideDir,
  removeReviewGuide,
  reviewBriefFile,
  reviewGuideDir,
  reviewGuideFile,
  reviewGuideInfo,
  reviewGuidePrompt,
  saveReviewGuidePrompt,
} from '../src/workspaces/review-guide.js';
import { resolveScripts } from '../src/workspaces/scripts.js';

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'beluga-guide-home-'));
  root = mkdtempSync(path.join(os.tmpdir(), 'platform-fe-'));
  vi.stubEnv('BELUGA_HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const writeGuide = (guide: string, brief?: string): void => {
  ensureReviewGuideDir(root);
  writeFileSync(reviewGuideFile(root), guide);
  if (brief !== undefined) writeFileSync(reviewBriefFile(root), brief);
};

describe('review guide storage', () => {
  it('keeps each project in a folder of its own under Beluga, outside the repository', () => {
    const dir = reviewGuideDir(root);
    expect(dir.startsWith(path.join(home, 'review-guides'))).toBe(true);
    expect(path.basename(dir)).toMatch(new RegExp(`^${path.basename(root)}-[0-9a-f]{8}$`));
    expect(reviewGuideDir(`${root}-other`)).not.toBe(dir);
  });

  it('has no guide until one is written, and says whether it has a brief', () => {
    expect(reviewGuideInfo(root)).toBeUndefined();
    writeGuide('# guide\n');
    expect(reviewGuideInfo(root)).toMatchObject({ size: 8, brief: false });
    writeFileSync(reviewBriefFile(root), '# Repository guidance\n');
    expect(reviewGuideInfo(root)?.brief).toBe(true);
  });

  it('an empty guide is no guide', () => {
    writeGuide('');
    expect(reviewGuideInfo(root)).toBeUndefined();
  });

  it('removing takes the guide and the brief out and keeps your prompt', () => {
    writeGuide('# guide\n', '# brief\n');
    saveReviewGuidePrompt(root, 'Write the guide for {{project}}.');
    removeReviewGuide(root);
    expect(reviewGuideInfo(root)).toBeUndefined();
    expect(customReviewGuidePrompt(root)).toBe('Write the guide for {{project}}.');
  });
});

describe('the prompt that writes it', () => {
  it('fills in the project and where to write, and leaves the guide path mark for each run', () => {
    const prompt = reviewGuidePrompt(root, 'platform-fe');
    expect(prompt).toContain(`Set up the review guide for platform-fe (the repository at ${root})`);
    expect(prompt).toContain(`## 2. Write ${reviewGuideFile(root)} in EXACTLY this structure`);
    expect(prompt).toContain(`## 3. Write ${reviewBriefFile(root)} in EXACTLY this structure`);
    expect(prompt).toContain(GUIDE_PATH_MARK);
    expect(prompt).not.toMatch(/\{\{(project|root|guide|brief)\}\}/);
  });

  it('uses yours once saved, and the built-in one again when cleared or set back to it', () => {
    saveReviewGuidePrompt(root, 'Only {{project}} at {{guide}}');
    expect(reviewGuidePrompt(root, 'app')).toBe(`Only app at ${reviewGuideFile(root)}`);
    saveReviewGuidePrompt(root, '');
    expect(customReviewGuidePrompt(root)).toBeUndefined();
    saveReviewGuidePrompt(root, 'x');
    saveReviewGuidePrompt(root, DEFAULT_REVIEW_GUIDE_PROMPT);
    expect(customReviewGuidePrompt(root)).toBeUndefined();
  });
});

describe('what runs are told', () => {
  it('nothing for a project without a guide', () => {
    expect(buildReviewGuideAppend(root)).toBe('');
  });

  it('the brief with the guide path put in, then to check before any pull request', () => {
    writeGuide('# guide\n', `# Repository guidance\n\nBefore editing code, read \`${GUIDE_PATH_MARK}\`.\n`);
    const text = buildReviewGuideAppend(root);
    expect(text).toContain(`<review_guidance>\n# Repository guidance\n\nBefore editing code, read \`${reviewGuideFile(root)}\`.\n</review_guidance>`);
    expect(text).not.toContain(GUIDE_PATH_MARK);
    expect(text).toContain(`Before you open or update a pull request (gh pr create, gh pr edit, or a push to a branch with one), check your diff against \`${reviewGuideFile(root)}\``);
  });

  it('only the guide, when it has no brief', () => {
    writeGuide('# guide\n');
    expect(buildReviewGuideAppend(root)).toContain(`This project has a review guide at \`${reviewGuideFile(root)}\``);
  });

  it('is listed in Built-in instructions', () => {
    const piece = instructionPieces('Mia').find((p) => p.id === 'review-guide');
    expect(piece).toMatchObject({ label: 'Review guide', when: 'Your own runs in a project with a review guide' });
    expect(piece?.text).toContain('check your diff against');
  });
});

describe('pull requests', () => {
  const ctx = { branch: 'beluga/fix', base: 'origin/main', project: 'platform-fe' };

  it('check the work against the guide before pushing, when the project has one', () => {
    const prompt = buildPrPrompt({ ...ctx, reviewGuide: '/g/guide.md' }, 'Open it.');
    expect(prompt).toContain("Before you push or open the pull request, check the work against this project's review guide, `/g/guide.md`");
    expect(prompt).toContain('add a "## Checked" section');
  });

  it('stay as they were without one', () => {
    expect(buildPrPrompt(ctx, 'Open it.')).toBe('Open it.');
  });

  it("the project's scripts say it has one", () => {
    mkdirSync(root, { recursive: true });
    expect(resolveScripts(root).reviewGuide).toBeUndefined();
    writeGuide('# guide\n');
    expect(resolveScripts(root).reviewGuide).toMatchObject({ brief: false });
  });
});

describe('Create PR in a project with a guide', () => {
  const bench = () => {
    const store = new Store(initialState('t', 'ask'));
    const w = { id: 'auth', name: 'auth', kind: 'worktree', branch: 'beluga/auth', path: path.join(root, 'wt'), projectId: 'p1', status: { changed: 0, ahead: 1, behind: 0, unpushed: 1 } };
    const manager = { list: [{ id: 'p1', name: 'platform-fe', root, base: 'origin/main', workspaces: [w] }], find: (id: string) => (id === w.id ? w : undefined), scripts: () => resolveScripts(root) };
    const asked: Array<{ prompt: string; channel: string }> = [];
    const opened: string[] = [];
    const wb = new Workbench({
      store,
      controller: { manager, open: () => undefined, refresh: async () => undefined } as unknown as WorkspaceController,
      notify: () => undefined,
      toast: () => undefined,
      intend: () => undefined,
      askClaude: (prompt, channel) => void asked.push({ prompt, channel }),
      setPrefs: () => undefined,
      hasGh: async () => true,
      createPr: async (_dir, made) => {
        opened.push(made.head);
        throw new Error('not here');
      },
    });
    store.dispatch({ type: 'gh', ok: true });
    return { wb, asked, opened };
  };

  it('goes through your agent, which checks the work against the guide before it opens the pull request', async () => {
    writeGuide('# guide\n');
    const b = bench();
    const out = await b.wb.quickPr('auth', { draft: true });
    expect(out.ok).toBe(true);
    expect(b.opened).toEqual([]);
    expect(b.asked).toHaveLength(1);
    expect(b.asked[0]!.channel).toBe('ws:auth');
    expect(b.asked[0]!.prompt).toContain(`check the work against this project's review guide, \`${reviewGuideFile(root)}\``);
    expect(b.asked[0]!.prompt).toContain('Open it as a draft (gh pr create --draft).');
  });

  it('opens it straight away without one', async () => {
    const b = bench();
    await b.wb.quickPr('auth');
    expect(b.asked).toEqual([]);
    expect(b.opened).toEqual(['beluga/auth']);
  });
});
