import { stripAnsi } from '../shared/ansi.js';
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
  const head = `I ran it through Beluga on ${state.where}: ${how}. ${check}`;
  if (!output) return `${head} It printed nothing.`;
  return `${head} Output${output.length < state.output.trim().length ? ' (last lines)' : ''}:\n\`\`\`text\n${output}\n\`\`\``;
};
