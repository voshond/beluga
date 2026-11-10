import { lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaHomeDir } from '../../../core/shares.js';
import type { AgentRunInput } from '../../types.js';
import type { AskForApproval } from './protocol.js';

/**
 * How a Codex run is confined (BLG-454). Codex runs its own commands and edits without asking
 * Beluga first (canGateEveryTool false), so what policy.ts would refuse per call, Codex's sandbox
 * makes unreachable instead: a permissions profile (Codex's `[permissions.<id>]`, macOS seatbelt)
 * that writes only to the run's folders, denies `.env` files, keys and credential stores outright,
 * and, for a friend's task, keeps the network off and the rest of your home out of reach.
 *
 * Who asks and how far their trust reaches (AgentRunInput.scope: full trust is 'full') pick the
 * row of CODEX_TRUST_TABLE; docs/security.md shows the same table (tests/codex-sandbox.test.ts
 * checks they match). Your own run may ask to go past the sandbox: Codex's approval request comes
 * to you through canUseTool, the same prompt as Claude's. A friend's task never can.
 */

/** Whose run it is: yours (an external agent's at full too: it is you, from another UI), an external agent's below full, a friend's (their agent asked, or a task from them), or a guest's. */
export type RunOrigin = 'own' | 'agent' | 'friend' | 'guest';

export function originOf(input: Pick<AgentRunInput, 'guest' | 'vetTool' | 'viaAgent' | 'asOwner'> & Partial<Pick<AgentRunInput, 'scope'>>): RunOrigin {
  // Read when the run starts: Codex does not stop at Beluga's gate, so a level changed later counts at the next run.
  if (input.asOwner) return input.scope === 'full' ? 'own' : 'agent';
  return input.guest ? 'guest' : input.vetTool || input.viaAgent ? 'friend' : 'own';
}

/** One row of the mapping: who asks × how far their trust reaches → sandbox and approvals. */
export interface TrustRow {
  readonly origin: RunOrigin;
  /** The trust levels it covers, in the app's words. */
  readonly trust: string;
  readonly scope: 'folder' | 'full' | 'any';
  /** Codex's built-in profile it extends. */
  readonly sandbox: ':workspace' | ':read-only' | 'refused';
  /** Reading your home outside the run's folders (credential stores are always denied). */
  readonly home: 'read' | 'denied';
  readonly network: boolean;
  /** When Codex wants past its sandbox: you're asked (on-request), or it can't (never). */
  readonly approval: AskForApproval;
  /** Your own MCP servers, plugins, apps and hooks from ~/.codex. */
  readonly yourTools: boolean;
}

export const CODEX_TRUST_TABLE: readonly TrustRow[] = [
  { origin: 'own', trust: '—', scope: 'any', sandbox: ':workspace', home: 'read', network: true, approval: 'on-request', yourTools: true },
  // Its commands run with no gate of Beluga's: a level below full has to hold in the sandbox. Network stays on for normal work, with home out of reach.
  { origin: 'agent', trust: 'An external agent below Full trust (Ask me each time needs Claude)', scope: 'any', sandbox: ':workspace', home: 'denied', network: true, approval: 'on-request', yourTools: false },
  { origin: 'friend', trust: 'Ask me each time, Trusted', scope: 'folder', sandbox: ':workspace', home: 'denied', network: false, approval: 'never', yourTools: false },
  { origin: 'friend', trust: 'Full trust', scope: 'full', sandbox: ':workspace', home: 'read', network: false, approval: 'never', yourTools: false },
  { origin: 'guest', trust: 'invited into one project', scope: 'any', sandbox: 'refused', home: 'denied', network: false, approval: 'never', yourTools: false },
];

export function trustRow(origin: RunOrigin, scope: 'folder' | 'full'): TrustRow {
  return CODEX_TRUST_TABLE.find((r) => r.origin === origin && (r.scope === 'any' || r.scope === scope))!;
}

/**
 * When this run's Codex asks you, beyond the row: while planning, never (it only looks; anything
 * past its read-only sandbox is declined anyway); your own run with "My agent asks before
 * commands" on, for every command that isn't plainly read-only ('untrusted'); the same for an
 * external agent's run its level makes ask. Friends' rows never change.
 */
export function approvalFor(row: TrustRow, opts: { readonly planning?: boolean; readonly askBeforeCommands?: boolean }): AskForApproval {
  if (opts.planning) return 'never';
  return row.approval === 'on-request' && opts.askBeforeCommands ? 'untrusted' : row.approval;
}

/** Credential stores in your home, denied to every Codex run (shares.ts's secret paths). */
const HOME_SECRETS = [
  '.ssh',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  '.gnupg',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
  '.pgpass',
  '.config/gh',
  '.config/hub',
  '.config/gcloud',
  '.config/op',
  '.config/1password',
  '.config/doctl',
  '.claude/.credentials.json',
  '.codex/auth.json',
  '.zsh_history',
  '.bash_history',
  'Library/Keychains',
  '.klaud',
  '.klaude',
];

/** Secret files by name, denied anywhere in the run's folders. Codex's globs can only deny, so `.env` templates go too. */
const SECRET_GLOBS = ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks', 'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*', '.npmrc', '.netrc', '.pypirc', '.git-credentials', '.pgpass', 'credentials', 'credentials.json', '.credentials.json'];

/** Codex's own features a friend's task never gets: what you set up for yourself. */
const YOUR_FEATURES = ['plugins', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'hooks', 'memories', 'multi_agent'];

export const PROFILE = 'beluga';

export interface CodexConfinement {
  readonly row: TrustRow;
  /** Thread config: the profile, made the default, and what's switched off. */
  readonly config: Record<string, unknown>;
  readonly approval: AskForApproval;
}

export interface ConfinementPlace {
  readonly cwd: string;
  /** The run's other folders (shares, a fixup worktree). */
  readonly folders: readonly string[];
  /** Of those (and cwd), the ones the run may change: none in a main folder, while planning, or in a read-only share. */
  readonly writable: readonly string[];
  /** Your own MCP servers in ~/.codex/config.toml, switched off when the row says so. */
  readonly yourServers?: readonly string[];
  readonly home?: string;
  readonly belugaHome?: string;
  /** A linked worktree's git folders (workspaces/git.ts worktreeGitDirs): your own run commits, branches and merges there. */
  readonly gitDirs?: { readonly shared: string; readonly own: string };
}

/**
 * Deny a path where it really is. Linux's sandbox (bubblewrap) can't mount over a link and fails the
 * whole run ("Can't mount on symlink destination"): the ~/.klaud the home's rename leaves pointing
 * at ~/.beluga, or a dotfile manager's ~/.config/gh. A link is denied at its target (still a
 * secret); a dangling one leads nowhere and is skipped; anything else (or absent) as named.
 */
function denyAt(filesystem: Record<string, string>, p: string): void {
  let link: boolean;
  try {
    link = lstatSync(p).isSymbolicLink();
  } catch {
    link = false;
  }
  if (!link) {
    filesystem[p] = 'deny';
    return;
  }
  try {
    filesystem[realpathSync(p)] = 'deny';
  } catch {
    // Dangling: nothing to read there.
  }
}

/** The run's confinement as Codex thread config (see the table above). */
export function codexConfinement(origin: RunOrigin, scope: 'folder' | 'full', place: ConfinementPlace): CodexConfinement {
  const row = trustRow(origin, scope);
  const home = place.home ?? os.homedir();
  const roots = [...new Set([place.cwd, ...place.folders].map((p) => path.resolve(p)))];
  const writable = new Set(place.writable.map((p) => path.resolve(p)));
  const filesystem: Record<string, string> = {};
  // Your home out of reach first (a friend reaching only shared folders); git still reads its config.
  if (row.home === 'denied') {
    filesystem[home] = 'deny';
    filesystem[path.join(home, '.gitconfig')] = 'read';
  }
  for (const rel of HOME_SECRETS) denyAt(filesystem, path.join(home, rel));
  // Beluga's own files (identity, settings, trust choices); the run's folders inside it stay open below.
  denyAt(filesystem, place.belugaHome ?? belugaHomeDir());
  for (const root of roots) filesystem[root] = writable.has(root) ? 'write' : 'read';
  for (const root of roots) for (const glob of SECRET_GLOBS) filesystem[`${root}/**/${glob}`] = 'deny';
  // A worktree's commits, branches and merges are written to the main checkout's .git, outside it:
  // without it every git write failed ("Git needed to write its shared metadata"). Your own run only,
  // and only where it may change the worktree. Hooks and config run code outside the sandbox the
  // next time you use git: read only.
  // Codex keeps a writable folder's .git read only, following a worktree's .git file to its own
  // folder (.git/worktrees/<name>): named here, so its index and HEAD can be written too.
  if (place.gitDirs && row.yourTools && writable.has(path.resolve(place.cwd))) {
    const g = path.resolve(place.gitDirs.shared);
    filesystem[g] = 'write';
    filesystem[path.resolve(place.gitDirs.own)] = 'write';
    filesystem[path.join(g, 'hooks')] = 'read';
    filesystem[path.join(g, 'config')] = 'read';
    filesystem[path.join(g, 'config.worktree')] = 'read';
    filesystem[path.join(path.resolve(place.gitDirs.own), 'config.worktree')] = 'read';
  }
  const config: Record<string, unknown> = {
    default_permissions: PROFILE,
    [`permissions.${PROFILE}`]: { extends: writable.has(path.resolve(place.cwd)) ? ':workspace' : ':read-only', filesystem, network: { enabled: row.network } },
  };
  if (!row.yourTools) {
    for (const name of place.yourServers ?? []) config[`mcp_servers.${name}.enabled`] = false;
    for (const feature of YOUR_FEATURES) config[`features.${feature}`] = false;
    // Your environment's tokens stay out of a friend's commands.
    config['shell_environment_policy.inherit'] = 'core';
  }
  return { row, config, approval: row.approval };
}

/**
 * A side call's confinement (codex/complete.ts): read only, as tight as a friend's task (your home
 * and its secret stores out of reach, `.env` files denied, none of your own Codex tools), whatever
 * asked for it: what a chat answer reads can come from a friend. The network is on only for a call
 * given Bash (a pull request's review runs git); one given no tools can't read the folder either.
 */
export function sideCallConfinement(cwd: string, opts: { readonly tools?: readonly string[]; readonly yourServers?: readonly string[]; readonly home?: string; readonly belugaHome?: string } = {}): CodexConfinement {
  const base = codexConfinement('friend', 'folder', { cwd, folders: [], writable: [], ...(opts.yourServers ? { yourServers: opts.yourServers } : {}), ...(opts.home ? { home: opts.home } : {}), ...(opts.belugaHome ? { belugaHome: opts.belugaHome } : {}) });
  const profile = base.config[`permissions.${PROFILE}`] as { extends: string; filesystem: Record<string, string>; network: { enabled: boolean } };
  const tools = opts.tools ?? [];
  const filesystem = tools.length ? profile.filesystem : { ...profile.filesystem, [path.resolve(cwd)]: 'deny' };
  return { ...base, config: { ...base.config, [`permissions.${PROFILE}`]: { ...profile, extends: ':read-only', filesystem, network: { enabled: tools.includes('Bash') } } } };
}

/** The table as docs/security.md shows it. */
export function trustTableMarkdown(): string {
  const yes = (b: boolean): string => (b ? 'on' : 'off');
  const who: Record<RunOrigin, string> = { own: 'Your own run', agent: "An external agent's run", friend: "A friend's task", guest: 'A guest' };
  const lines = [
    '| Who asks | Trust | Files | Rest of your home | Network | `.env`, keys, credential stores | Going past the sandbox | Your Codex tools |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...CODEX_TRUST_TABLE.map((r) =>
      r.sandbox === 'refused'
        ? `| ${who[r.origin]} | ${r.trust} | refused | | | | | |`
        : `| ${who[r.origin]} | ${r.trust} | ${r.sandbox === ':workspace' ? "write the run's folders" : 'read only'} | ${r.home} | ${yes(r.network)} | denied by the sandbox | ${r.approval === 'on-request' ? 'asks you' : 'not possible'} | ${yes(r.yourTools)} |`,
    ),
  ];
  return lines.join('\n');
}
