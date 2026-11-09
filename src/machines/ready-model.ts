/**
 * Getting a computer ready for a project (BLG-787), as plain data: where its projects go, what a
 * project needs (from its own files), what the computer is missing, how to install that the
 * system's own way (a user-level install first, sudo only when there's none and it's allowed),
 * the steps with their words, and git's errors in plain words. No I/O here (ready.ts runs it);
 * tested on its own (tests/machines-ready.test.ts). Browser-safe: the app draws the same steps.
 */

export type ReadyPlatform = 'macos' | 'linux' | 'windows';
export type PackageManager = 'brew' | 'apt' | 'dnf' | 'apk';

/** What a computer's system offers for installing things. */
export interface ReadySystem {
  readonly platform: ReadyPlatform;
  /** "Ubuntu 24.04", "macOS 15.1". */
  readonly release?: string;
  readonly pkg?: PackageManager;
  /** sudo works without a password (an installer may use it). */
  readonly sudo: boolean;
  /** nvm is installed for this user. */
  readonly nvm: boolean;
}

export type Tool = 'node' | 'pnpm' | 'yarn' | 'bun' | 'python' | 'uv' | 'poetry' | 'ruby' | 'bundler' | 'go';

/** Something the project needs, and the file that says so. */
export interface Need {
  readonly tool: Tool;
  /** "20", ">=18", "3.12", "1.22" (none: any). */
  readonly version?: string;
  readonly from: string;
}

/** The files read to know what a project needs. */
export const NEED_FILES = ['.nvmrc', '.node-version', '.tool-versions', 'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json', '.python-version', 'pyproject.toml', 'uv.lock', 'poetry.lock', 'requirements.txt', 'Gemfile', '.ruby-version', 'go.mod'] as const;

/** How each tool says its version (run in a login shell, nvm loaded when it's there). */
export const VERSION_COMMANDS: Readonly<Record<Tool, string>> = {
  node: 'node --version',
  pnpm: 'pnpm --version',
  yarn: 'yarn --version',
  bun: 'bun --version',
  python: 'python3 --version',
  uv: 'uv --version',
  poetry: 'poetry --version',
  ruby: 'ruby --version',
  bundler: 'bundle --version',
  go: 'go version',
};

const TOOL_WORDS: Readonly<Record<Tool, string>> = { node: 'Node', pnpm: 'pnpm', yarn: 'Yarn', bun: 'Bun', python: 'Python', uv: 'uv', poetry: 'Poetry', ruby: 'Ruby', bundler: 'Bundler', go: 'Go' };

/** "Node 20", "Python 3.12 or later", "pnpm". */
export function toolWords(need: Pick<Need, 'tool' | 'version'>): string {
  const name = TOOL_WORDS[need.tool];
  const v = need.version?.trim();
  if (!v || v === '*' || /^lts/i.test(v)) return name;
  const at = /^>=?\s*v?([\d.]+)/.exec(v);
  if (at) return `${name} ${short(at[1]!)} or later`;
  const exact = /^[~^=v]*\s*([\d.]+)/.exec(v);
  return exact ? `${name} ${short(exact[1]!)}` : name;
}

/** 20.11.0 → 20.11; 20 → 20. */
const short = (v: string): string => v.split('.').slice(0, 2).join('.');

/** The first version number in what a tool printed ("v20.11.1", "Python 3.12.3", "go version go1.22.1 linux/amd64"). */
export function versionIn(printed: string): string | undefined {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(printed)?.[1] ?? /(\d+)/.exec(printed)?.[1];
}

const nums = (v: string): number[] => v.split('.').map((n) => Number.parseInt(n, 10)).filter((n) => Number.isFinite(n));

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < b.length; i++) {
    const d = (a[i] ?? 0) - b[i]!;
    if (d) return d;
  }
  return 0;
}

/** Whether `have` (a printed version) is what `need` asks for: the same release as far as it says, or at least it for `>=`. */
export function satisfies(need: Pick<Need, 'version'>, have: string | undefined): boolean {
  if (have === undefined) return false;
  const v = need.version?.trim();
  if (!v || v === '*' || /^lts/i.test(v)) return true;
  const got = nums(have);
  const atLeast = /^>=?\s*v?([\d.]+)/.exec(v);
  if (atLeast) return compare(got, nums(atLeast[1]!)) >= 0;
  // ^20 / ~20.1 / 20 / 20.11.0: the same major (and minor when it says one).
  const exact = /^[~^=v]*\s*([\d.]+)/.exec(v);
  if (!exact) return true;
  const want = nums(exact[1]!).slice(0, v.startsWith('^') ? 1 : 2);
  return compare(got.slice(0, want.length), want) === 0;
}

const line1 = (text: string | undefined): string | undefined => text?.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));

function toolVersions(text: string | undefined): Partial<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const l of (text ?? '').split('\n')) {
    const [name, version] = l.trim().split(/\s+/);
    if (name && version && !name.startsWith('#')) out[name] = version;
  }
  return out;
}

/** What a project needs, from its own files (`files`: NEED_FILES' contents, missing ones undefined). */
export function needsOf(files: Readonly<Partial<Record<string, string>>>): Need[] {
  const needs: Need[] = [];
  const add = (n: Need): void => {
    if (!needs.some((x) => x.tool === n.tool)) needs.push(n);
  };
  const tv = toolVersions(files['.tool-versions']);
  let pkg: { engines?: { node?: string }; packageManager?: string } | undefined;
  try {
    pkg = files['package.json'] ? (JSON.parse(files['package.json']) as typeof pkg) : undefined;
  } catch {
    pkg = undefined;
  }
  // Node: the version files first, then package.json's engines.
  const nodeV = line1(files['.nvmrc']) ?? line1(files['.node-version']) ?? tv.nodejs ?? tv.node;
  if (nodeV) add({ tool: 'node', version: nodeV, from: files['.nvmrc'] ? '.nvmrc' : files['.node-version'] ? '.node-version' : '.tool-versions' });
  else if (pkg) add({ tool: 'node', ...(pkg.engines?.node ? { version: pkg.engines.node } : {}), from: 'package.json' });
  const manager = pkg?.packageManager ? /^(pnpm|yarn|bun)@/.exec(pkg.packageManager)?.[1] : undefined;
  if (files['pnpm-lock.yaml'] !== undefined || manager === 'pnpm') add({ tool: 'pnpm', from: files['pnpm-lock.yaml'] !== undefined ? 'pnpm-lock.yaml' : 'package.json' });
  else if (files['yarn.lock'] !== undefined || manager === 'yarn') add({ tool: 'yarn', from: files['yarn.lock'] !== undefined ? 'yarn.lock' : 'package.json' });
  else if (files['bun.lockb'] !== undefined || files['bun.lock'] !== undefined || manager === 'bun') add({ tool: 'bun', from: 'bun.lock' });
  // Python: its version file, else pyproject's requires-python; uv or Poetry by their lockfiles.
  const pyproject = files['pyproject.toml'];
  const pyV = line1(files['.python-version']) ?? tv.python ?? (pyproject ? /requires-python\s*=\s*["']([^"']+)["']/.exec(pyproject)?.[1] : undefined);
  if (pyV || pyproject !== undefined || files['requirements.txt'] !== undefined) add({ tool: 'python', ...(pyV ? { version: pyV.split(',')[0]!.trim() } : {}), from: files['.python-version'] ? '.python-version' : pyproject !== undefined ? 'pyproject.toml' : 'requirements.txt' });
  if (files['uv.lock'] !== undefined) add({ tool: 'uv', from: 'uv.lock' });
  if (files['poetry.lock'] !== undefined) add({ tool: 'poetry', from: 'poetry.lock' });
  // Ruby and Bundler for a Gemfile.
  const rubyV = line1(files['.ruby-version']) ?? tv.ruby;
  if (files.Gemfile !== undefined || rubyV) {
    add({ tool: 'ruby', ...(rubyV ? { version: rubyV.replace(/^ruby-/, '') } : {}), from: files['.ruby-version'] ? '.ruby-version' : 'Gemfile' });
    if (files.Gemfile !== undefined) add({ tool: 'bundler', from: 'Gemfile' });
  }
  // Go: go.mod's go line.
  const goV = files['go.mod'] ? /^go\s+([\d.]+)/m.exec(files['go.mod'])?.[1] : (tv.golang ?? tv.go);
  if (files['go.mod'] !== undefined || goV) add({ tool: 'go', ...(goV ? { version: `>=${goV}` } : {}), from: files['go.mod'] !== undefined ? 'go.mod' : '.tool-versions' });
  return needs;
}

/** A need the computer doesn't meet. */
export interface Missing {
  readonly need: Need;
  /** What it has instead (none: not there at all). */
  readonly have?: string;
  /** "Node 20 (it has 18.19)", "pnpm". */
  readonly words: string;
}

export function missingOf(needs: readonly Need[], have: Readonly<Partial<Record<Tool, string>>>): Missing[] {
  return needs.flatMap((need) => {
    const got = have[need.tool];
    if (satisfies(need, got)) return [];
    return [{ need, ...(got ? { have: got } : {}), words: got ? `${toolWords(need)} (it has ${short(got)})` : toolWords(need) }];
  });
}

/** How a missing tool gets installed there. */
export interface InstallPlan {
  readonly tool: Tool;
  /** "Node 20 with nvm, for you only", "Go with apt (needs sudo)". */
  readonly words: string;
  /** The command, run in a login shell there. */
  readonly command?: string;
  readonly sudo: boolean;
  /** It can be done from here (else `why` says who has to). */
  readonly can: boolean;
  readonly why?: string;
}

// --no-use: loading nvm with no Node of its own yet exits 3, which stopped the chain (seen on a real run, BLG-842).
const NVM = '. "$HOME/.nvm/nvm.sh" --no-use';
const NVM_INSTALL = 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash';
const UV_INSTALL = 'curl -LsSf https://astral.sh/uv/install.sh | sh';
const UV = '"$HOME/.local/bin/uv"';
/** A version as nvm, uv or a package takes it: 20 for ">=20", 3.12 for "3.12.1". */
const plainVersion = (v: string | undefined, parts = 1): string | undefined => {
  const at = v ? /([\d.]+)/.exec(v)?.[1] : undefined;
  return at ? at.split('.').slice(0, parts).join('.') : undefined;
};

/** The system's own packages for a tool (none: it has no package there). */
const PACKAGES: Readonly<Partial<Record<Tool, Readonly<Record<PackageManager, string>>>>> = {
  ruby: { brew: 'ruby', apt: 'ruby-full', dnf: 'ruby', apk: 'ruby' },
  go: { brew: 'go', apt: 'golang-go', dnf: 'golang', apk: 'go' },
  python: { brew: 'python', apt: 'python3', dnf: 'python3', apk: 'python3' },
};

const pkgCommand = (pkg: PackageManager, name: string, sudo: boolean): string => {
  const s = sudo ? 'sudo -n ' : '';
  switch (pkg) {
    case 'brew':
      return `brew install ${name}`;
    case 'apt':
      return `${s}apt-get install -y ${name}`;
    case 'dnf':
      return `${s}dnf install -y ${name}`;
    case 'apk':
      return `${s}apk add ${name}`;
  }
};

/** Through the system's own packages: brew needs no sudo; the rest only when sudo works without asking. */
function bySystem(tool: Tool, words: string, sys: ReadySystem): InstallPlan {
  const name = PACKAGES[tool]?.[sys.pkg ?? 'apt'];
  if (!sys.pkg || !name) return { tool, words, sudo: false, can: false, why: `${words} has no installer Beluga knows there: install it yourself` };
  const sudo = sys.pkg !== 'brew';
  const command = pkgCommand(sys.pkg, name, sudo);
  if (sudo && !sys.sudo) return { tool, words: `${words} with ${sys.pkg}`, command: command.replace('sudo -n ', 'sudo '), sudo, can: false, why: `${words} needs an administrator there: run \`${command.replace('sudo -n ', 'sudo ')}\`` };
  return { tool, words: `${words} with ${sys.pkg}${sudo ? ' (sudo)' : ''}`, command, sudo, can: true };
}

/** The way to install a missing tool there: a user-level one first (nvm, uv, npm's own folder, Bun's), else the system's packages. */
export function installPlan(m: Missing, sys: ReadySystem): InstallPlan {
  const { tool } = m.need;
  const words = toolWords(m.need);
  switch (tool) {
    case 'node': {
      const v = plainVersion(m.need.version) ?? '--lts';
      const nvm = `${NVM} && nvm install ${v}${v === '--lts' ? '' : ` && nvm alias default ${v}`}`;
      return { tool, words: `${words} with nvm, for you only`, command: sys.nvm ? nvm : `${NVM_INSTALL} && ${nvm}`, sudo: false, can: true };
    }
    case 'pnpm':
    case 'yarn':
      return { tool, words: `${words} with npm, for you only`, command: `npm install -g --prefix "$HOME/.local" ${tool}`, sudo: false, can: true };
    case 'bun':
      return { tool, words: `${words}, for you only`, command: 'curl -fsSL https://bun.sh/install | bash', sudo: false, can: true };
    case 'uv':
      return { tool, words: 'uv, for you only', command: UV_INSTALL, sudo: false, can: true };
    case 'python': {
      const v = plainVersion(m.need.version, 2);
      return { tool, words: `${words} with uv, for you only`, command: `(command -v uv >/dev/null || [ -x ${UV} ] || ${UV_INSTALL}) && ${UV} python install${v ? ` ${v}` : ''} --default`, sudo: false, can: true };
    }
    case 'poetry':
      return { tool, words: 'Poetry with uv, for you only', command: `(command -v uv >/dev/null || [ -x ${UV} ] || ${UV_INSTALL}) && ${UV} tool install poetry`, sudo: false, can: true };
    case 'bundler':
      return { tool, words: 'Bundler, for you only', command: 'gem install --user-install bundler', sudo: false, can: true };
    case 'ruby':
    case 'go':
      return bySystem(tool, words, sys);
  }
}

/** For the setup agent: which system it works out the setup for. */
export function systemNote(sys: ReadySystem): string {
  const os = sys.platform === 'macos' ? 'macOS' : sys.platform === 'windows' ? 'Windows' : 'Linux';
  const parts = [sys.release ? `${os} (${sys.release})` : os, sys.pkg ? `packages with ${sys.pkg}` : undefined, sys.platform === 'linux' ? (sys.sudo ? 'sudo allowed' : 'no sudo') : undefined, sys.nvm ? 'Node by nvm' : undefined];
  return parts.filter(Boolean).join(', ');
}

/** Where projects go there: one that's already there (~/Projects, ~/projects, ~/code…), else ~/Projects on a Mac and ~/projects elsewhere. */
export function projectsFolder(platform: ReadyPlatform, home: string, isDir: (dir: string) => boolean, set?: string): string {
  if (set) return set.replace(/^~(?=$|\/)/, home);
  for (const rel of ['Projects', 'projects', 'Developer', 'code', 'Code', 'dev', 'repos', 'GitHub']) if (isDir(`${home}/${rel}`)) return `${home}/${rel}`;
  return `${home}/${platform === 'macos' ? 'Projects' : 'projects'}`;
}

/** Where a clone goes: `folder/name`, or `name-2`… when that's taken by something else. */
export function cloneTarget(folder: string, name: string, taken: (dir: string) => boolean): string {
  let dir = `${folder}/${name}`;
  for (let i = 2; taken(dir) && i < 100; i++) dir = `${folder}/${name}-${i}`;
  return dir;
}

/** git's or gh's trouble cloning, in plain words, with the fix when there's one. */
export function cloneTrouble(output: string, computer: string, gh: 'signed_in' | 'signed_out' | 'missing'): { readonly words: string; readonly fix?: { readonly words: string; readonly command: string } } {
  const signIn = gh !== 'signed_in' ? { fix: { words: 'Sign In There', command: 'gh auth login' } } : {};
  if (/permission denied \(publickey\)|could not read username|authentication failed|terminal prompts disabled|403|denied to/i.test(output)) {
    return { words: gh === 'signed_in' ? `${computer} can’t get at the repository: its GitHub sign-in has no access to it` : `${computer} isn’t signed in to GitHub, so it can’t get the repository`, ...signIn };
  }
  if (/repository not found|not found|does not exist/i.test(output)) return { words: `${computer} can’t find the repository: it may be private, or its address changed`, ...signIn };
  if (/could not resolve host|network is unreachable|timed out|connection refused/i.test(output)) return { words: `${computer} can’t reach the repository’s server right now` };
  if (/no space left/i.test(output)) return { words: `${computer} is out of disk space` };
  if (/command not found: git|git: not found|git: command not found/i.test(output)) return { words: `git isn’t installed on ${computer}` };
  const last = output.trim().split('\n').filter(Boolean).pop();
  return { words: last ? `Cloning failed on ${computer}: ${last.slice(0, 200)}` : `Cloning failed on ${computer}` };
}

export type StepState = 'todo' | 'active' | 'done' | 'failed' | 'asking' | 'skipped';
export type StepId = 'folder' | 'clone' | 'tools' | 'setup';

export interface ReadyStep {
  readonly id: StepId;
  /** "Projects folder", "Cloning bob-api", "Node 20, pnpm", "Setup: pnpm install". */
  readonly label: string;
  readonly state: StepState;
  /** More about it ("~/projects/bob-api", "Already there"). */
  readonly detail?: string;
  /** What went wrong, in plain words. */
  readonly error?: string;
  readonly fix?: { readonly words: string; readonly command?: string };
}

/** One run of getting a project ready there, as the app follows it (machines.ready.status). */
export interface ReadyRun {
  readonly id: string;
  /** The computer's own name (for "Getting build-box ready"). */
  readonly computer: string;
  readonly project: string;
  readonly origin: string;
  readonly state: 'running' | 'asking' | 'done' | 'failed';
  readonly steps: readonly ReadyStep[];
  /** Waiting on you: what's missing there and how each would be installed (Install them, or not). */
  readonly missing?: readonly InstallPlan[];
  /** Once it's there: the project on that computer. */
  readonly projectId?: string;
  readonly path?: string;
  /** The setup new worktrees run there (worked out for that system, kept on that computer). */
  readonly setup?: string;
}

export const firstSteps = (project: string): ReadyStep[] => [
  { id: 'folder', label: 'Projects folder', state: 'todo' },
  { id: 'clone', label: `Cloning ${project}`, state: 'todo' },
  { id: 'tools', label: 'Tools it needs', state: 'todo' },
  { id: 'setup', label: 'Setup', state: 'todo' },
];

/** A step changed (a new run, nothing changed in place). */
export function withStep(run: ReadyRun, id: StepId, patch: Partial<Omit<ReadyStep, 'id'>>): ReadyRun {
  return { ...run, steps: run.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

/** What it's doing, said once: "Getting build-box ready: cloning, Node 20, npm ci". */
export function readyLine(run: Pick<ReadyRun, 'computer' | 'steps' | 'state'>): string {
  if (run.state === 'done') return `${run.computer} is ready`;
  const failed = run.steps.find((s) => s.state === 'failed');
  if (failed) return `${run.computer} couldn’t get ready: ${failed.error ?? failed.label}`;
  if (run.state === 'asking') return `${run.computer} needs tools installed first`;
  const words = run.steps.filter((s) => s.state === 'active' || s.state === 'todo').map((s) => stepWord(s));
  return `Getting ${run.computer} ready${words.length ? `: ${words.join(', ')}` : ''}`;
}

const stepWord = (s: ReadyStep): string => {
  if (s.id === 'clone') return 'cloning';
  if (s.id === 'folder') return 'its folder';
  if (s.id === 'tools') return s.label === 'Tools it needs' ? 'tools' : s.label;
  return s.label.startsWith('Setup: ') ? s.label.slice(7) : 'setup';
};
