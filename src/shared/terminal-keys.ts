// The names of terminal programs Beluga runs (a workspace's shell, setup and run; the global shells).

export const shellId = (wsId: string): string => wsId;
export const setupId = (wsId: string): string => `${wsId}:setup`;
export const runId = (wsId: string): string => `${wsId}:run`;
/** A Toolbox tool run in a terminal, keyed by project id + tool id (BLG-75). */
export const toolboxTermId = (projectId: string, toolId: string): string => `toolbox:${projectId}:${toolId}`;
/** A GitHub setup step Beluga runs where you can see it (installing gh, logging in), BLG-213. */
export const githubId = (wsId: string): string => `${wsId}:github`;
/** The agent's own terminal (Claude Code's or Codex's) on a workspace's conversation, BLG-534. */
export const agentTermId = (wsId: string): string => `${wsId}:agent`;
export const isAgentTerm = (key: string): boolean => key.endsWith(':agent');
/** Why the agent's terminal didn't open: a turn is running in the chat. The Mac waits for it instead of failing (BLG-553). */
export const TERM_BUSY = 'Your agent is still on a turn in the chat here: let it finish (or stop it), then open the terminal.';
export const isTermBusy = (message: string): boolean => message.includes(TERM_BUSY);
/** A shell split beside the agent's terminal: `<wsId>:pane:1`, `<wsId>:pane:2`… */
export const paneTermId = (wsId: string, n: number): string => `${wsId}:pane:${n}`;
/** Shells of the global Terminal tab (not tied to a workspace): `shell:1`, `shell:2`… */
export const globalShellId = (n: number): string => `shell:${n}`;
export const isGlobalShell = (key: string): boolean => /^shell:\d+$/.test(key);
export const globalShellNumber = (key: string): number => Number(key.slice('shell:'.length)) || 0;
export const SSH_HOST = /^[A-Za-z0-9][\w.-]{0,252}$/;
export const sshShellId = (host: string): string => `ssh:${host}`;
export const sshHostOf = (key: string): string => key.slice('ssh:'.length);
export const isSshShell = (key: string): boolean => key.startsWith('ssh:') && SSH_HOST.test(sshHostOf(key));
export const isOwnShell = (key: string): boolean => isGlobalShell(key) || isSshShell(key);

/**
 * Where a new global shell starts: the project you last opened a workspace in, else the
 * project Beluga was started in, else your home folder.
 */
export function globalShellDir(projects: readonly { root: string; workspaces: readonly { id: string }[] }[], openTabs: readonly string[], launchDir: string, home: string): string {
  for (const id of [...openTabs].reverse()) {
    const p = projects.find((x) => x.root && x.workspaces.some((w) => w.id === id));
    if (p) return p.root;
  }
  const sep = launchDir.includes('\\') ? '\\' : '/';
  const launched = projects.find((p) => p.root && (launchDir === p.root || launchDir.startsWith(p.root + sep)));
  return launched?.root ?? home;
}

/** Longest name you can give a terminal. */
export const MAX_TERMINAL_NAME = 40;

/** A name typed for a terminal, tidied: one line, no control characters, not too long ('' resets it). */
// eslint-disable-next-line no-control-regex
export const cleanTerminalName = (name: string): string => name.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TERMINAL_NAME);

/** What a terminal's tab says: the name you gave it, else Shell N, Shell, Setup, Run or GitHub. */
export function terminalLabel(key: string, names: Readonly<Record<string, string>> = {}): string {
  const named = names[key];
  if (named) return named;
  if (isGlobalShell(key)) return `Shell ${globalShellNumber(key)}`;
  if (isSshShell(key)) return sshHostOf(key);
  if (key.startsWith('toolbox:')) return key.split(':')[3] ?? 'Tool';
  return key.endsWith(':setup') ? 'Setup' : key.endsWith(':run') ? 'Run' : key.endsWith(':github') ? 'GitHub' : isAgentTerm(key) ? 'Agent' : 'Shell';
}
