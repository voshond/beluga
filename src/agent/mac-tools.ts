import { tool, toolSuite } from './tool-kit.js';
import { z } from 'zod';
import type { MacTools } from './types.js';

/**
 * "Your Mac" (BLG-47, core/assistant): the tools of the assistant conversation you talk to from
 * the phone and the Mac, not tied to any project (server `beluga_mac`). It looks at this Mac (a
 * screenshot, device info), says what's here (projects, worktrees, what runs) and starts work:
 * a worktree with Claude on it, a task from the board, a plan. What it starts it names in its
 * answer as `worktree:<id>`, `task:<KEY>` or `plan:<id>`, which both screens draw as links. It
 * also archives a worktree you ask it to (BLG-565), the same lossless archive as the app's.
 */

export const MAC_TOOL_NAMES = ['screenshot', 'device_info', 'list_work', 'start_worktree', 'start_task', 'start_plan', 'archive_worktree'].map((n) => `mcp__beluga_mac__${n}`);

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

async function guarded(fn: () => Promise<Content[]> | Content[]): Promise<{ content: Content[]; isError?: boolean }> {
  try {
    return { content: await fn() };
  } catch (err) {
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
  }
}

const words = (text: string): Content[] => [{ type: 'text', text }];

export function createMacToolDefs(mac: MacTools) {
  return [
    tool(
      'screenshot',
      "Take a screenshot of this Mac's screen (the main display, or the front window of one app). It's saved in your scratch folder, so it shows as an output on the owner's phone and Mac, and you see it too. macOS asks for Screen Recording permission the first time.",
      { app: z.string().min(1).max(80).optional().describe('Only this app’s front window (its name, e.g. "Safari"); leave out for the whole main display') },
      (a) =>
        guarded(async () => {
          const shot = await mac.screenshot(a.app);
          return [{ type: 'text', text: shot.text }, ...(shot.image ? [{ type: 'image' as const, data: shot.image.data, mimeType: shot.image.mimeType }] : [])];
        }),
    ),
    tool('device_info', 'A summary of this Mac: macOS version, model, processor, memory, disk space, battery, local network addresses and installed apps.', {}, () => guarded(async () => words(await mac.deviceInfo()))),
    tool(
      'list_work',
      'What is on this Mac in Beluga: the projects (by name), their worktrees and chats (with ids), which conversations have Claude working right now, and the plans.',
      {},
      () => guarded(() => words(mac.listWork())),
    ),
    tool(
      'start_worktree',
      'Start a new worktree in one of the projects (a branch and folder of its own from the latest origin) with that worktree’s own Claude working on `message` right away. Returns its id: name it in your answer as `worktree:<id>`.',
      {
        project: z.string().min(1).max(200).describe('The project’s name (from list_work)'),
        message: z.string().min(1).max(16_000).describe('The first message for the worktree’s Claude: the task, complete and self-contained (it sees only this)'),
        name: z.string().min(1).max(60).optional().describe('A short branch-style name ("login-bug"); left out, Beluga names it'),
        plan: z.boolean().optional().describe('true: its Claude plans first and asks the owner to approve before changing anything'),
      },
      (a) => guarded(async () => words(await mac.startWorktree({ project: a.project, message: a.message, ...(a.name ? { name: a.name } : {}), ...(a.plan ? { plan: true } : {}) }))),
    ),
    tool(
      'start_task',
      'Start a task from the board: a worktree of its own with Claude carrying it through. Create it first with task_create if it isn’t on the board yet. Returns the worktree: name both in your answer (`task:<KEY>`, `worktree:<id>`).',
      { key: z.string().min(2).max(40).describe('The task’s key, like BLG-12') },
      (a) => guarded(async () => words(await mac.startTask(a.key))),
    ),
    tool(
      'start_plan',
      'Start a plan in a project: its own conversation where Claude drafts milestones and tasks for the owner to approve. Returns its id: name it in your answer as `plan:<id>`.',
      { project: z.string().min(1).max(200).describe('The project’s name (from list_work)'), goal: z.string().min(1).describe('What the plan is for, in a few sentences') },
      (a) => guarded(async () => words(await mac.startPlan({ project: a.project, goal: a.goal }))),
    ),
    tool(
      'archive_worktree',
      'Archive a worktree the owner asked you to, as the app’s Archive does: its branch, conversation and uncommitted work are kept and it can be restored any time; its dependencies and builds are freed. Only worktrees (not a project’s main folder or a chat). If its Claude is still working, it refuses: ask the owner, then call again with confirmed: true.',
      {
        worktree: z.string().min(1).max(200).describe('The worktree’s id from list_work (or its exact name)'),
        confirmed: z.boolean().optional().describe('true only after the owner said yes to stopping a Claude still working in it'),
      },
      (a) => guarded(async () => words(await mac.archiveWorktree({ worktree: a.worktree, ...(a.confirmed ? { confirmed: true } : {}) }))),
    ),
  ];
}

export function createMacTools(mac: MacTools) {
  return toolSuite({ name: 'beluga_mac', version: '0.1.0', tools: createMacToolDefs(mac) });
}
