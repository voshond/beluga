import type { Complete } from './runtime/types.js';

const FIX_TIMEOUT_MS = 90_000;
const OUTPUT_CHARS = 4000;
const MAX_COMMAND = 2000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

/** What a project's setup should be: a command to run in new worktrees, or nothing at all. */
export type SetupFix = { readonly command: string } | { readonly none: true };

/** What a project's run command should be: one to start it, or nothing (it isn't something you run). */
export type ScriptFix = SetupFix;

/** Commands Claude worked out for a project (only the ones it was asked for). */
export interface WorkedOutScripts {
  readonly setup?: ScriptFix;
  readonly run?: ScriptFix;
}

/** The answer out of what the model said: its last `<label>:` line, `none` or one command. */
export function parseScriptLine(raw: string, label: 'SETUP' | 'RUN'): ScriptFix | undefined {
  const head = new RegExp(`^${label}:`, 'i');
  const line = raw
    .trim()
    .split('\n')
    .reverse()
    .map((l) => l.trim().replace(/^`+|`+$/g, ''))
    .find((l) => head.test(l));
  const answer = line?.replace(head, '').trim().replace(/^`+|`+$/g, '').trim();
  if (!answer) return undefined;
  if (/^none\.?$/i.test(answer)) return { none: true };
  return answer.length <= MAX_COMMAND ? { command: answer } : undefined;
}

/** The answer out of what the model said: its last `SETUP:` line, `none` or one command. */
export const parseSetupFix = (raw: string): SetupFix | undefined => parseScriptLine(raw, 'SETUP');

const LOOK =
  "Be quick: look at the README, manifests, lockfiles, Makefile/justfile, Procfile and scripts only. Prefer the project's own tooling (a Makefile or justfile target, a package.json script) over generic commands, and the package manager the project's lockfile belongs to. Never suggest anything that installs into the system (sudo, brew, `make install`) or deploys.";

/** One read-only look at the project by a model (no commands): what it said at the end, or undefined on any trouble. */
async function ask(dir: string, prompt: string, system: string, opts: { complete: Complete; model?: string }): Promise<string | undefined> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), FIX_TIMEOUT_MS);
  timer.unref();
  try {
    return await opts.complete({
      prompt,
      cwd: dir,
      model: opts.model ?? 'sonnet',
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep'],
      maxTurns: 8,
      signal: abortController.signal,
      system,
    });
  } catch {
    // No answer.
  } finally {
    clearTimeout(timer);
  }
  return undefined;
}

const tailOf = (output: string): string => output.replace(ANSI, '').slice(-OUTPUT_CHARS);

/**
 * A worktree's setup failed: a model looks at the project's files (read-only, no commands) and
 * the failure, and says what the setup should be, or that it needs none. Undefined on any trouble.
 */
export async function fixSetup(dir: string, failed: string, output: string, opts: { complete: Complete; model?: string }): Promise<SetupFix | undefined> {
  const said = await ask(
    dir,
    `The setup command for new worktrees of this project failed.\n\nCommand: ${failed}\nOutput (end):\n"""\n${tailOf(output)}\n"""\n\nLook at the project's files and decide the right setup command (installing dependencies so the project can run), or that it needs no setup.`,
    `You fix the setup command a git worktree runs once when it's created. ${LOOK} If nothing needs installing, the answer is none. End with exactly one line: \`SETUP: <one shell command>\` or \`SETUP: none\`.`,
    opts,
  );
  return said === undefined ? undefined : parseSetupFix(said);
}

/**
 * A project's Run button failed: a model looks at the files and the failure and says what the
 * run command should be, or that it doesn't know a better one (none). Undefined on any trouble.
 */
export async function fixRun(dir: string, failed: string, output: string, opts: { complete: Complete; model?: string }): Promise<ScriptFix | undefined> {
  const said = await ask(
    dir,
    `The Run command of this project (what its Run button starts, e.g. a dev server) failed.\n\nCommand: ${failed}\nOutput (end):\n"""\n${tailOf(output)}\n"""\n\nLook at the project's files and decide the right run command. If the command is right and the project itself is what's broken (a code error, a missing file or setting), the answer is none.`,
    `You fix the command a project's Run button starts in its git worktree (dependencies are already installed by its setup). ${LOOK} End with exactly one line: \`RUN: <one shell command>\` or \`RUN: none\`.`,
    opts,
  );
  return said === undefined ? undefined : parseScriptLine(said, 'RUN');
}

/**
 * A project's first new worktree, and its own files don't say how to set it up or run it: a model
 * looks (read-only) and says, for each one asked, a command or none. Undefined on any trouble.
 */
export async function workOutScripts(dir: string, want: { setup: boolean; run: boolean; system?: string }, opts: { complete: Complete; model?: string }): Promise<WorkedOutScripts | undefined> {
  const parts = [want.setup && 'SETUP: the one command that installs what the project needs in a fresh checkout (dependencies, including those of sub-packages with their own manifest or lockfile, chained with &&), or none if nothing does', want.run && 'RUN: the one command that starts it for development (a dev server, the app, the CLI with no arguments), or none if it isn\'t something you run (a library, docs)'].filter(Boolean);
  if (!parts.length) return {};
  const said = await ask(
    dir,
    `This project was just opened in a new git worktree. Work out:\n${parts.map((p) => `- ${p}`).join('\n')}${want.system ? `\n\nIt runs on ${want.system}: pick commands that work on that system, with the tools it has.` : ''}`,
    `You work out the commands Beluga runs for a project: Setup once in every new git worktree, and Run when its Run button is pressed. ${LOOK} End with exactly one line for each asked: ${[want.setup && '\`SETUP: <one shell command>\` or \`SETUP: none\`', want.run && '\`RUN: <one shell command>\` or \`RUN: none\`'].filter(Boolean).join(', then ')}.`,
    opts,
  );
  if (said === undefined) return undefined;
  const setup = want.setup ? parseScriptLine(said, 'SETUP') : undefined;
  const run = want.run ? parseScriptLine(said, 'RUN') : undefined;
  return { ...(setup ? { setup } : {}), ...(run ? { run } : {}) };
}
