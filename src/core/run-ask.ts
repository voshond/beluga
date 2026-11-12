import { stripAnsi } from '../shared/ansi.js';
import type { ClaudeAnswer, ClaudeQuestion } from '../protocol.js';
import type { PendingQuestion } from './collab-store.js';

export type RunAsk = {
  readonly on?: string;
  readonly commands: readonly string[];
  readonly expect?: string;
};

export type RunAskPrompt = {
  readonly text: string;
  readonly secret: boolean;
};

export type RunAskStatus = 'running' | 'done' | 'failed' | 'stopped';

export type RunAskState = {
  readonly status: RunAskStatus;
  readonly where: string;
  readonly output: string;
  readonly startedAt: number;
  readonly prompt?: RunAskPrompt;
  readonly exit?: number;
  readonly error?: string;
};

export const RUN_ASK_MAX_OUTPUT = 16_000;
export const RUN_ASK_ANSWER_OUTPUT = 3000;
export const RUN_ASK_TIMEOUT_MS = 10 * 60_000;
const RUN_ANSWER_HEAD = 'I ran it through Beluga on ';

const RUNNABLE_FENCE = /^(`{3,}|~{3,})[ \t]*(sh|bash|zsh|shell)[ \t]*\n([\s\S]*?)^\1[ \t]*$/gm;
const RUN_ON = /(?:^|\n)[^\n]*\bRun on \*\*([^*\n]{1,80})\*\*/;
const WORKED_WHEN = /^\s*It worked when:\s*(.{1,300}?)\s*$/im;
const SECRET_PROMPT = /(password|passphrase|passcode|verification code|one-time code|otp|\bpin)\b[^\n]{0,80}[:?]\s*$/i;
const CONFIRM_PROMPT = /(\(yes\/no(\/\[fingerprint\])?\)\?|\[y\/n\]:?|\(y\/n\)\??)\s*$/i;

export const runAskIn = (markdown: string): RunAsk | undefined => {
  const blocks = [...markdown.matchAll(RUNNABLE_FENCE)];
  if (blocks.length !== 1) return undefined;
  const block = blocks[0]!;
  const commands = block[3]!.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim());
  if (!commands.length) return undefined;
  const on = RUN_ON.exec(markdown.slice(0, block.index))?.[1]?.trim();
  const expect = WORKED_WHEN.exec(markdown.slice(block.index + block[0].length))?.[1];
  return { ...(on ? { on } : {}), commands, ...(expect ? { expect } : {}) };
};

export const runnableQuestion = (q: PendingQuestion, selfId: string, question: string): RunAsk | undefined => {
  if (q.owner !== selfId || q.question.kind !== 'question') return undefined;
  if (!q.question.questions.some((x) => x.question === question)) return undefined;
  return runAskIn(question);
};

/** Commands someone runs for an agent: the machine (left out, this one), the folder, the commands and how they tell it worked. */
export type RunCommands = {
  readonly on?: string;
  readonly cwd?: string;
  readonly commands: readonly string[];
  readonly expect?: string;
};

const shellWord = (text: string): string => (/^[\w@%+=:,./~-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);

/** What you run, as the card shows it: the machine, the commands in a block to copy (its folder is the cd that starts it), and how you tell it worked. */
export function runMarkdown(run: RunCommands): string {
  const commands = [...(run.cwd ? [`cd ${shellWord(run.cwd)}`] : []), ...run.commands];
  return [`Run${run.on ? ` on **${run.on}**` : ''}:`, '```sh', ...commands, '```', run.expect ? `It worked when: ${run.expect}` : ''].filter(Boolean).join('\n');
}

/** A card's question holds this many characters (the protocol's cap). */
export const RUN_CARD_MAX = 1000;
export const RUN_CARD_TITLE = 'Run this for me';

/**
 * A run card (run_for_me): a question with no options and one block of commands. Claude's own
 * questions always come with options, so this shape is only ever a run card.
 */
export const isRunCard = (question: ClaudeQuestion): boolean => question.kind === 'question' && question.questions.length === 1 && question.questions[0]!.options.length === 0 && runAskIn(question.questions[0]!.question) !== undefined;

/** The card run_for_me puts up: why, then the commands. Too long for a card: why it doesn't fit. */
export const runCard = (why: string, run: RunCommands, title?: string): ClaudeQuestion | string => {
  const commands = run.commands.map((c) => c.trimEnd()).filter((c) => c.trim());
  if (!why.trim()) return 'Say why they need to run it.';
  if (!commands.length) return 'Give at least one command.';
  if (commands.some((c) => /^(`{3,}|~{3,})/.test(c.trim()))) return 'Give the commands themselves, without a code fence.';
  const question = `${why.trim()}\n\n${runMarkdown({ ...run, commands })}`;
  if (question.length > RUN_CARD_MAX) return `That is ${question.length} characters and a card holds ${RUN_CARD_MAX}: shorten why, or put the long part in a script and run that.`;
  const parsed = runAskIn(question);
  if (!parsed || parsed.on !== (run.on?.trim() || undefined)) return 'Keep code blocks and "Run on" lines out of why: it is words only, the commands go in commands.';
  return { kind: 'question', questions: [{ question, header: (title?.trim() || RUN_CARD_TITLE).slice(0, 40), options: [], multiSelect: false }] };
};

/** What run_for_me tells the agent: the run's own answer, the user's words, or that they skipped it. */
export const runCardResult = (answer: ClaudeAnswer): string => {
  if (answer.kind !== 'answers') return 'The user skipped it: nothing was run. Carry on without it, or say what is still waiting on them.';
  const text = Object.values(answer.answers)[0]?.trim() ?? '';
  if (!text) return 'The user answered without running it or saying anything. Ask them in your answer what happened.';
  if (text.startsWith(RUN_ANSWER_HEAD)) return text;
  return `The user didn't run it through Beluga and answered instead: ${text}`;
};

export const plainOutput = (raw: string): string =>
  stripAnsi(raw)
    .replace(/\r\n/g, '\n')
    .replace(/[^\n]*\r(?=[^\n])/g, '')
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');

export const promptIn = (output: string): RunAskPrompt | undefined => {
  const last = output.slice(output.lastIndexOf('\n') + 1);
  if (!last.trim()) return undefined;
  if (SECRET_PROMPT.test(last)) return { text: last.trim(), secret: true };
  if (CONFIRM_PROMPT.test(last)) return { text: last.trim(), secret: false };
  return undefined;
};

export const tail = (text: string, max: number): string => (text.length > max ? text.slice(text.length - max) : text);

export const scrubbed = (output: string, secrets: readonly string[]): string => secrets.filter((s) => s.length >= 3).reduce((text, secret) => text.split(secret).join('••••'), output);

const normalHost = (on: string): string =>
  on
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s*\(.*\)\s*$/, '')
    .trim();

const LOCAL_WORDS: ReadonlySet<string> = new Set(['', 'this machine', 'this one', 'this mac', 'this computer', 'here', 'local', 'localhost']);

export type RunTarget = { readonly kind: 'local'; readonly where: string } | { readonly kind: 'ssh'; readonly host: string; readonly where: string };

export const runTarget = (on: string | undefined, hostname: string, sshHosts: readonly string[]): RunTarget | undefined => {
  const self = hostname.toLowerCase().split('.')[0] ?? '';
  const wanted = normalHost(on ?? '');
  if (LOCAL_WORDS.has(wanted) || wanted === self || wanted === hostname.toLowerCase()) return { kind: 'local', where: on?.trim() || hostname || 'this machine' };
  const candidates = [wanted, wanted.split(/\s+/)[0] ?? ''];
  const host = sshHosts.find((h) => candidates.includes(h.toLowerCase()));
  return host ? { kind: 'ssh', host, where: host } : undefined;
};

export const runAnswer = (state: RunAskState, expect?: string): string => {
  const output = tail(state.output.trim(), RUN_ASK_ANSWER_OUTPUT);
  const how = state.error ? `it failed: ${state.error}` : `exit code ${state.exit ?? 'unknown'}`;
  const check = expect ? `Check the output against what success looks like (${expect}) and decide whether it worked.` : 'Check the output and decide whether it worked.';
  const head = `${RUN_ANSWER_HEAD}${state.where}: ${how}. ${check}`;
  if (!output) return `${head} It printed nothing.`;
  return `${head} Output${output.length < state.output.trim().length ? ' (last lines)' : ''}:\n\`\`\`text\n${output}\n\`\`\``;
};
