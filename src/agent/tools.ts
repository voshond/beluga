import { tool, toolSuite } from './tool-kit.js';
import { z } from 'zod';
import type { RoomBridge, SetupTools } from './types.js';
import { isFullPath } from '../core/home-path.js';
import { type DialogueTurnTools, endDialogueToolDef } from './dialogue-tools.js';
import { createGatewayToolDefs } from './gateway-tools.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
  isError: true,
});

async function guarded(fn: () => Promise<string> | string): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

export const ROOM_TOOL_NAMES = [
  'send_chat',
  'list_peers',
  'ask_agent',
  'run_on_peer',
  'list_peer_files',
  'read_peer_file',
  'get_peer_file',
  'send_file',
  'write_report',
].map((n) => `mcp__beluga__${n}`);

/** A file send_file can take: a full path (/…, or C:\… and \\server\… on Windows), or one from home (~/… or ~\…). */
export const isSendablePath = (p: string): boolean => isFullPath(p) || /^~[\\/]/.test(p);

export function createRoomToolDefs(bridge: RoomBridge) {
  return [
      tool('send_chat', 'Post a mid-task update or question to the group chat. Do not use it to repeat your final answer; the room already sees that.', { text: z.string().min(1).max(4000) }, (a) =>
        guarded(() => {
          bridge.sendChat(a.text);
          return 'sent';
        }),
      ),
      tool('list_peers', "List people in the room: their Claude, shared folders, projects and workspaces you can name, and what their trust in you lets you do (lets_you).", {}, () =>
        guarded(() =>
          JSON.stringify(
            bridge.describePeers?.() ?? bridge.listPeers().map((p) => ({ name: p.name, agent: p.agent, shares: p.shares, you: p.name === bridge.selfName() })),
            null,
            2,
          ),
        ),
      ),
      tool(
        'ask_agent',
        "Send a task to another peer's Claude agent (runs on their machine). Its progress shows in the chat; returns its final answer.",
        {
          peer: z.string().describe('Peer name from list_peers'),
          prompt: z.string().min(1).max(16000),
          project: z.string().min(1).max(80).optional().describe('One of their projects or shared workspaces (from list_peers) to work in'),
        },
        (a) => guarded(() => bridge.askAgent(a.peer, a.prompt, a.project)),
      ),
      tool(
        'run_on_peer',
        "Run a shell command on a friend's computer through their Beluga (non-interactive, no input). They approve it unless they fully trust you; commands touching secrets are refused. Returns the exit code and output (its end, up to 64 KB).",
        {
          peer: z.string().describe('Peer name from list_peers'),
          command: z.string().min(1).max(8000),
          project: z.string().min(1).max(80).optional().describe('Run in one of their projects (from list_peers)'),
          cwd: z.string().max(4096).optional().describe('Folder on their computer (~ is their home). Default: their shared folder (home with full trust)'),
          timeout_sec: z.number().int().min(1).max(600).default(120).describe('Stop it after this long (max 600)'),
          why: z.string().max(500).optional().describe('One line shown to them when they approve'),
        },
        (a) =>
          guarded(() => {
            if (!bridge.runOnPeer) throw new Error('Running commands on other computers is not available here');
            return bridge.runOnPeer(a.peer, a.command, { ...(a.cwd ? { cwd: a.cwd } : {}), ...(a.project ? { project: a.project } : {}), timeoutSec: a.timeout_sec, ...(a.why ? { why: a.why } : {}) });
          }),
      ),
      tool(
        'list_peer_files',
        "List a directory in a peer's shared folder.",
        { peer: z.string(), share: z.string(), path: z.string().default('') },
        (a) => guarded(async () => JSON.stringify(await bridge.listPeerFiles(a.peer, a.share, a.path))),
      ),
      tool(
        'read_peer_file',
        "Read a text file from a peer's shared folder.",
        { peer: z.string(), share: z.string(), path: z.string() },
        (a) => guarded(() => bridge.readPeerFile(a.peer, a.share, a.path)),
      ),
      tool(
        'get_peer_file',
        "Copy a file from anywhere on a peer's computer to this one (e.g. their ~/Desktop/report.pdf). The peer approves unless they fully trust you; secrets are never sent. Returns where the file was saved here.",
        {
          peer: z.string().describe('Peer name from list_peers'),
          path: z.string().min(1).max(4096).describe('Path on their computer; ~ means their home folder'),
          save_to: z.string().max(4096).optional().describe('Folder on THIS computer to save into (e.g. ~/Desktop). Default: ~/Downloads/Beluga/<peer>'),
          why: z.string().max(500).optional().describe('One line shown to them when they approve'),
        },
        (a) => guarded(async () => `Saved to ${await bridge.getPeerFile(a.peer, a.path, a.save_to, a.why)}`),
      ),
      tool(
        'send_file',
        "Send a file from this computer to a peer (for example the result of work they asked for). It's saved in their Downloads folder. Use it to send results back to whoever asked you.",
        {
          peer: z.string().describe('Peer name from list_peers'),
          path: z
            .string()
            .min(1)
            .max(4096)
            .refine(isSendablePath, 'Use a full path (/…, C:\\… or ~/…)')
            .describe('Full path of the file on this computer (/…, C:\\… on Windows, or ~/…)'),
          note: z.string().max(1000).optional(),
        },
        (a) => guarded(() => bridge.sendFile(a.peer, a.path, a.note)),
      ),
      tool(
        'write_report',
        'Write a Markdown report to .beluga/reports/ and announce it so everyone can follow it live.',
        { title: z.string().min(1).max(200), markdown: z.string().min(1).max(200_000) },
        (a) => guarded(async () => `Report written to ${await bridge.writeReport(a.title, a.markdown)}`),
      ),
  ];
}

export const CONTINUE_TOOL = 'mcp__beluga__continue_in_worktree';

/** For runs in a project's main folder: turn the chat into a new worktree and work there. */
export function continueInWorktreeToolDef(move: (task: string) => Promise<string>) {
  return tool(
    'continue_in_worktree',
    "You're in the project's read-only main folder. Call this as soon as the request needs any change: Beluga turns this chat into a new worktree from the latest origin (same conversation, its own folder) and you continue the task there. Then end your turn with one short line.",
    { task: z.string().min(1).max(8000).describe('The change to make, as a complete instruction (it starts the work in the new worktree)') },
    (a) => guarded(() => move(a.task)),
  );
}

/** For your own runs in a worktree: correct the setup new worktrees of this project run once. */
export function setProjectSetupToolDef(setup: SetupTools) {
  return tool(
    'set_project_setup',
    "Change the setup command Beluga runs once in every new worktree of this project, when you found it incomplete (you had to install dependencies or run a step it doesn't). Give the whole command a fresh checkout needs, chained with &&.",
    {
      command: z.string().min(1).max(2000).describe('The full setup command, e.g. `npm install && (cd packages/app && npm install)`'),
      why: z.string().min(1).max(300).describe('What was missing, in a few words (shown to the owner)'),
    },
    (a) => guarded(async () => setup.set(a.command, a.why)),
  );
}

/** The Beluga tools for one run: the room's, plus continue_in_worktree in a main folder, plus set_project_setup in a worktree, plus end_dialogue in a dialogue's turn. */
export function createRoomTools(bridge: RoomBridge, move?: (task: string) => Promise<string>, setup?: SetupTools, dialogue?: DialogueTurnTools) {
  return toolSuite({ name: 'beluga', version: '0.1.0', tools: [...createRoomToolDefs(bridge), ...createGatewayToolDefs(bridge), ...(move ? [continueInWorktreeToolDef(move)] : []), ...(setup ? [setProjectSetupToolDef(setup)] : []), ...(dialogue ? [endDialogueToolDef(dialogue)] : [])] });
}
