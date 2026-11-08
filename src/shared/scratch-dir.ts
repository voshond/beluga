/** Beluga's own folder in each workspace (reports, scratch), kept out of git. */
export const PROJECT_DIR = '.beluga';
/** The same folder from before the rename: still read where it's there, never made again. */
export const LEGACY_PROJECT_DIR = '.klaud';

/**
 * Where a workspace's scratch folder is, from its root: in Beluga's own `.beluga/` (beside reports),
 * never `.context/`, which other tools (Conductor) keep for themselves in the same worktrees.
 */
export const SCRATCH_DIR = `${PROJECT_DIR}/scratch`;

/**
 * The folders the Scratch tab shows, from the workspace's root: Beluga's own, the one from before the
 * rename (`.klaud/scratch`, where older runs saved), then `.context/`, where Claude saves the same kind
 * of files when another tool (Conductor) runs it in this worktree. Those are only looked at: Beluga never
 * makes them, writes to them or keeps them out of git.
 */
export const SHOWN_SCRATCH_DIRS = [SCRATCH_DIR, `${LEGACY_PROJECT_DIR}/scratch`, '.context'] as const;

/**
 * Copies of what you sent your agent with a message (images, files): `.beluga/scratch/sent/`, so it
 * can work with them later. A worktree's own conversation keeps them right there; a conversation that
 * shares its folder with others (Your Mac's chats, a chat in a folder) in its own `sent/<name>/`.
 */
export const SENT_DIR = `${SCRATCH_DIR}/sent`;

/** A conversation's own folder name in `sent/`, from its channel (`mac:assistant:ab12` → `mac-assistant-ab12`). */
export const sentName = (channel: string): string => channel.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';

/**
 * Where a conversation's copies go, from its folder's root: a worktree's own conversation keeps them
 * in `sent/`, one sharing its folder in `sent/<its name>/` (so deleting it takes only its own).
 */
export const sentFolder = (channel: string, ownFolder: boolean): string => (ownFolder ? SENT_DIR : `${SENT_DIR}/${sentName(channel)}`);

/** Whether a scratch path (from the workspace's root) is one of the copies you sent. */
export const isSentPath = (p: string): boolean => p.startsWith(`${SENT_DIR}/`);

/** Each sub-agent's own folder in it: `.beluga/scratch/agents/<name>/`. */
export const AGENT_SCRATCH_DIR = `${SCRATCH_DIR}/agents`;

/** A sub-agent's folder name, from the tool call that started it (Claude Code records it for the agent too). */
export const agentScratchName = (toolUseId: string): string => toolUseId.replace(/[^\w-]/g, '').slice(-10) || 'agent';
