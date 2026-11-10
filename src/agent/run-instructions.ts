import type { AgentRef } from '../protocol.js';
import type { InstructionPieceView } from '../shared/agent-setup.js';
import { buildGraphAppend } from './graph-prompt.js';
import { buildAskOnlyAppend, buildCommitAppend, buildKeepAppend, buildMachineAppend, buildScratchAppend, buildSetupAppend, buildShellAppend, buildShippedAppend, buildSystemAppend } from './prompt.js';
import { buildSyncMainAppend } from './sync-main.js';
import { buildTerminalAppend } from './terminal-prompt.js';
import type { AgentRunInput } from './types.js';
import { buildViewAppend } from './view-prompt.js';

type PieceContext = {
  readonly input: AgentRunInput;
  readonly ownerName: string;
  readonly agent?: AgentRef;
  readonly askOnly: boolean;
  readonly worktree: boolean;
};

type InstructionPiece = {
  readonly id: string;
  readonly label: string;
  readonly when: string;
  readonly source: string;
  readonly text: (ctx: PieceContext) => string;
  readonly sample?: (ownerName: string) => string;
};

const SAMPLE_PROJECT = 'your-project';

export const INSTRUCTION_PIECES: readonly InstructionPiece[] = [
  { id: 'room', label: 'Who you are in the room', when: 'Every run', source: 'src/agent/prompt.ts', text: (c) => buildSystemAppend(c.ownerName, c.agent), sample: (owner) => buildSystemAppend(owner) },
  { id: 'machine', label: 'About this machine', when: 'Your own runs, when About this machine is on', source: 'Settings › Skills', text: (c) => c.input.machineBrief ?? '' },
  { id: 'graphs', label: 'Graphs', when: 'Every run', source: 'src/agent/graph-prompt.ts', text: (c) => buildGraphAppend(Boolean(c.input.terminal)), sample: () => buildGraphAppend() },
  { id: 'views', label: 'Views', when: 'Every run', source: 'src/agent/view-prompt.ts', text: (c) => buildViewAppend(Boolean(c.input.terminal)), sample: () => buildViewAppend() },
  { id: 'task', label: 'Task brief', when: 'Runs with the task board (a worktree doing a task, a main folder)', source: 'src/core/board/prompt.ts', text: (c) => c.input.taskBrief ?? '' },
  { id: 'plan', label: 'Plan brief', when: 'A plan’s conversations', source: 'src/core/plans/prompt.ts', text: (c) => c.input.planBrief ?? '' },
  { id: 'mac', label: 'Your Mac', when: 'Your Mac’s assistant', source: 'src/core/assistant', text: (c) => c.input.macBrief ?? '' },
  { id: 'shared', label: 'A friend’s worktree', when: 'Your agent in a worktree a friend shared with you', source: 'src/core/shared-guest.ts', text: (c) => c.input.sharedBrief ?? '' },
  { id: 'phone', label: 'Your phone', when: 'Your own runs, with a phone set up', source: 'src/core/phone', text: (c) => c.input.phoneBrief ?? '' },
  { id: 'preview', label: 'Live previews', when: 'Your own runs, with Live previews on (Settings › Experimental)', source: 'src/core/previews', text: (c) => (c.input.terminal ? '' : (c.input.previewBrief ?? '')) },
  { id: 'sentinel', label: 'Sentinel', when: 'Your own runs (a sentinel run gets its brief)', source: 'src/core/sentinel/prompt.ts', text: (c) => c.input.sentinelBrief ?? '' },
  { id: 'dialogue', label: 'Dialogue turn', when: 'A turn of a chaired dialogue', source: 'src/core/dialogues/prompt.ts', text: (c) => c.input.dialogue?.brief ?? '' },
  {
    id: 'setup',
    label: 'Project setup',
    when: 'Your own runs in a worktree',
    source: 'src/agent/prompt.ts',
    text: (c) => (c.input.setup && !c.askOnly ? c.input.setup.brief : ''),
    sample: () => buildSetupAppend(SAMPLE_PROJECT, 'npm ci', 'detected'),
  },
  { id: 'scratch', label: 'Scratch folder', when: 'Worktree runs, with Scratch folder on', source: 'src/agent/prompt.ts', text: (c) => (c.input.scratchDir ? buildScratchAppend(c.input.scratchDir) : ''), sample: () => buildScratchAppend('.beluga/scratch') },
  { id: 'shell', label: 'Your shell is zsh', when: 'Every run, when your login shell is zsh', source: 'src/agent/prompt.ts', text: () => buildShellAppend(), sample: () => buildShellAppend('/bin/zsh', 'darwin') },
  { id: 'keep', label: 'Processes that keep running', when: 'Worktree runs', source: 'src/agent/prompt.ts', text: (c) => (c.worktree ? buildKeepAppend(c.agent) : ''), sample: () => buildKeepAppend() },
  { id: 'commit', label: 'Commit before ending', when: 'Worktree runs (not a plan’s, not in a main folder)', source: 'src/agent/prompt.ts', text: (c) => (c.worktree && !c.input.planBrief && !c.askOnly ? buildCommitAppend(c.input.place?.openPr) : ''), sample: () => buildCommitAppend() },
  {
    id: 'shipped',
    label: 'Continue after merge',
    when: 'A worktree whose pull request merged, kept working in',
    source: 'src/agent/prompt.ts',
    text: (c) => (c.input.place?.shipped && !c.askOnly ? buildShippedAppend(c.input.place.shipped) : ''),
    sample: () => buildShippedAppend({ number: 42, into: 'main' }),
  },
  {
    id: 'ask-only',
    label: 'Main folder: read-only',
    when: 'Runs in a project’s main folder',
    source: 'src/agent/prompt.ts',
    text: (c) => {
      const askOnly = c.input.place?.askOnly;
      if (!askOnly) return '';
      const syncMain = c.input.place?.syncMain;
      return syncMain ? buildSyncMainAppend(askOnly.project, syncMain.branch, syncMain.upstream) : buildAskOnlyAppend(askOnly.project, Boolean(c.input.continueInWorktree), Boolean(c.input.board));
    },
    sample: () => buildAskOnlyAppend(SAMPLE_PROJECT, true, true),
  },
  { id: 'terminal', label: 'Terminal view', when: 'The agent’s own terminal in Beluga', source: 'src/agent/terminal-prompt.ts', text: (c) => (c.input.terminal ? buildTerminalAppend() : ''), sample: () => buildTerminalAppend() },
  { id: 'remote-client', label: 'Driven from another computer', when: 'Runs your app started from another computer', source: 'src/agent/run-instructions.ts', text: (c) => (c.input.env?.BELUGA_REMOTE_CLIENT ? buildRemoteClientAppend() : ''), sample: () => buildRemoteClientAppend() },
];

export function runInstructions(input: AgentRunInput, ownerName: string, agent?: AgentRef): string {
  const askOnly = Boolean(input.place?.askOnly);
  const ctx: PieceContext = { input, ownerName, ...(agent ? { agent } : {}), askOnly, worktree: Boolean(input.env?.KLAUD_WORKTREE) };
  return INSTRUCTION_PIECES.map((piece) => piece.text(ctx)).join('');
}

/**
 * A run your app started from another computer (BLG-803): the person isn't at this one. Their app
 * forwards this computer's servers to theirs at the same port, so localhost is the address to give.
 */
export function buildRemoteClientAppend(): string {
  return (
    '\n\nThe person you work for is on another computer (their laptop or phone), driving this one through Beluga; ' +
    "they can't see this computer's screen. Servers you start here are forwarded to them at the same port, so give " +
    'addresses as http://localhost:<port> (never this computer’s host name or IP). Do not open browsers, apps or windows ' +
    'on this computer (no `open`, `xdg-open` or browser launches): they would show here, where nobody is. A screenshot of ' +
    'this screen shows this computer, not theirs.'
  );
}

export const instructionPieces = (ownerName: string, machineNote?: string): InstructionPieceView[] =>
  INSTRUCTION_PIECES.map(({ id, label, when, source, sample }) => {
    const text = id === 'machine' ? (machineNote ? buildMachineAppend(machineNote) : undefined) : sample?.(ownerName);
    return { id, label, when, source, ...(text ? { text: text.trim() } : {}) };
  });
