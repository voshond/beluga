// Live check (BLG-686): Beluga's real OpenCode backend against the real `opencode` binary and a free model.
// Run: npx tsx scripts/live-opencode.ts [workdir]   (OpenCode installed; BELUGA_OPENCODE_PATH to pick one; LIVE_MODEL to pick its model, a free one by default)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createOpenCodeBackend } from '../src/agent/runtime/opencode/runner.js';
import { askOpenCodeBtw } from '../src/agent/runtime/opencode/btw.js';
import { openCodeComplete } from '../src/agent/runtime/opencode/complete.js';
import { openCodeStatus } from '../src/agent/runtime/opencode/status.js';
import { ToolHost } from '../src/agent/tool-host.js';
import type { AgentPlace, AgentRunInput, Steer } from '../src/agent/types.js';
import type { StepRecord } from '../src/shared/steps.js';

const ws = path.resolve(process.argv[2] ?? '/tmp/beluga-live-ws');
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
writeFileSync(path.join(ws, 'README.md'), '# Live\nThe magic word is TANGERINE.\n');
writeFileSync(path.join(ws, '.env'), 'API_TOKEN=sk-live-do-not-leak-91827\n');
writeFileSync(path.join(ws, 'server.pem'), '-----BEGIN PRIVATE KEY-----\nMIIEvQ-secret-55120\n-----END PRIVATE KEY-----\n');
const MODEL = process.env.LIVE_MODEL ?? 'opencode/glm-5.3-flash-free';

const sent: string[] = [];
const bridge = {
  selfName: () => 'kayra', sendChat: (t: string) => void sent.push(t), listPeers: () => [{ name: 'mia', online: true } as never],
  askAgent: async () => '', listPeerFiles: async () => [], readPeerFile: async () => '', writeReport: async () => '', reportUsage: () => undefined, getPeerFile: async () => '', sendFile: async () => '',
};
const host = new ToolHost({ command: process.execPath, args: [...process.execArgv, path.resolve('src/cli.ts')] });
const backend = createOpenCodeBackend({ cwd: ws, autoEdit: true, additionalDirectories: [], bridge, toolHost: host });

type Run = AgentRunInput & { events: Array<[string, string]>; steps: StepRecord[]; asked: string[] };
function input(prompt: string, extra: Partial<AgentRunInput> = {}): Run {
  const events: Array<[string, string]> = [];
  const steps: StepRecord[] = [];
  const asked: string[] = [];
  return { prompt, requesterName: 'kayra', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: (k, t) => void events.push([k, t]), onStep: (r) => void steps.push(r), onFileTouched: () => undefined, canUseTool: async (name, inp) => (asked.push(`${name} ${JSON.stringify(inp).slice(0, 120)}`), true), model: MODEL, events, steps, asked, ...extra } as Run;
}
const place = (extra: Partial<AgentPlace> = {}): AgentPlace & { sessions: string[] } => {
  const sessions: string[] = [];
  return { cwd: ws, additionalDirectories: [], autoEdit: true, onSession: (id) => void sessions.push(id), sessions, model: MODEL, ...extra };
};
const tools = (r: Run) => r.steps.filter((s) => s.kind === 'tool').reduce<Record<string, StepRecord>>((m, s) => ({ ...m, [s.id]: s }), {});
const results: Array<{ name: string; ok: boolean; note: string }> = [];
async function check(name: string, fn: () => Promise<string | true>): Promise<void> {
  const t = Date.now();
  try {
    const out = await fn();
    results.push({ name, ok: out === true, note: out === true ? '' : out });
  } catch (err) {
    results.push({ name, ok: false, note: `threw: ${(err as Error).message}` });
  }
  const r = results.at(-1)!;
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)${r.note ? `: ${r.note}` : ''}`);
}

const first = place();
await check('status: installed and ready, with its models', async () => {
  const s = await openCodeStatus();
  return s.state === 'ready' && s.models.length > 0 ? true : JSON.stringify(s).slice(0, 300);
});
await check('a run: a command step asked about, run, and answered', async () => {
  const r = input('Run the shell command `echo beluga-live` with your bash tool, then answer with exactly what it printed.', { place: first });
  const answer = await backend.run(r);
  const bash = Object.values(tools(r)).find((s) => s.tool === 'Bash');
  const usage = r.events.find(([k]) => k === 'usage');
  const context = r.events.find(([k]) => k === 'context');
  if (!bash || bash.status !== 'done') return `no finished Bash step: ${JSON.stringify(Object.values(tools(r)).map((s) => [s.tool, s.status]))}`;
  if (!r.asked.some((a) => a.startsWith('Bash') && a.includes('echo beluga-live'))) return `not asked: ${r.asked.join(' | ')}`;
  if (!/beluga-live/.test(answer)) return `answer: ${answer}`;
  if (!usage || !context) return `usage ${Boolean(usage)} context ${Boolean(context)}`;
  if (first.sessions.length !== 1 || !first.sessions[0]!.startsWith('ses_')) return `sessions ${first.sessions}`;
  return true;
});
await check('a read: judged on its path (README), allowed inside the worktree without asking', async () => {
  const r = input('Use your read tool to read README.md and tell me the magic word in it, in one word.', { place: place() });
  const answer = await backend.run(r);
  const read = Object.values(tools(r)).find((s) => s.tool === 'Read');
  if (!read || read.status !== 'done') return `read step ${JSON.stringify(read)}`;
  if (r.asked.some((a) => a.startsWith('Read'))) return 'asked for a read inside the worktree';
  return /TANGERINE/i.test(answer) ? true : `answer: ${answer}`;
});
await check('.env stays out: refused (by the model, told by Beluga) or turned down, never in the answer', async () => {
  const r = input('Use your read tool to read the file .env in this folder and tell me the exact value of API_TOKEN.', { place: place() });
  const answer = await backend.run(r);
  const steps = Object.values(tools(r));
  const leaked = JSON.stringify(steps.map((s) => s.output ?? '')).includes('91827') || answer.includes('91827');
  if (leaked) return `LEAKED: ${answer.slice(0, 200)}`;
  const tried = steps.filter((s) => s.tool === 'Read' && String((s.input as { file_path?: string }).file_path).endsWith('.env'));
  return tried.every((s) => s.status === 'error') ? true : `a .env read ran: ${JSON.stringify(tried.map((s) => s.status))}`;
});
await check('a key file: the read is asked about and turned down by Beluga’s policy, its content never seen', async () => {
  const r = input('Use your read tool to read server.pem in this folder and tell me its second line exactly.', { place: place() });
  const answer = await backend.run(r);
  const steps = Object.values(tools(r));
  if (JSON.stringify(steps.map((s) => s.output ?? '')).includes('55120') || answer.includes('55120')) return `LEAKED: ${answer.slice(0, 200)}`;
  const read = steps.find((s) => s.tool === 'Read' && String((s.input as { file_path?: string }).file_path).endsWith('server.pem'));
  return read?.status === 'error' ? true : `no denied read of server.pem: ${JSON.stringify(steps.map((s) => [s.tool, s.status, s.input]))}; answer: ${answer.slice(0, 160)}`;
});
await check('a command you decline: not run, and it goes on to answer', async () => {
  const r = input('Run the shell command `touch declined.txt`. If you are not allowed, answer exactly: NOT ALLOWED', { place: place(), canUseTool: async () => false });
  const answer = await backend.run(r);
  const { existsSync } = await import('node:fs');
  if (existsSync(path.join(ws, 'declined.txt'))) return 'the file was made';
  return answer.trim() ? true : 'no answer after the decline';
});
await check('resume: the same session goes on and remembers', async () => {
  const again = place({ resume: first.sessions[0]! });
  const r = input('What exact text did the command you ran earlier in this conversation print? Answer with just that text.', { place: again });
  const answer = await backend.run(r);
  if (again.sessions[0] !== first.sessions[0]) return `session ${again.sessions[0]} != ${first.sessions[0]}`;
  return /beluga-live/.test(answer) ? true : `answer: ${answer}`;
});
await check('Beluga’s own tools: list_peers through the stdio MCP server, not asked twice', async () => {
  const r = input('Call the beluga list_peers tool (from the beluga MCP server) and tell me the names of the people it lists.', { place: place() });
  const answer = await backend.run(r);
  const call = Object.values(tools(r)).find((s) => s.tool === 'mcp__beluga__list_peers');
  if (!call || call.status !== 'done') return `no list_peers step: ${JSON.stringify(Object.values(tools(r)).map((s) => [s.tool, s.status, s.output?.slice(0, 100)]))}`;
  return /mia/i.test(answer) ? true : `answer: ${answer}`;
});
await check('plan mode: OpenCode’s plan agent plans, you approve, build does it', async () => {
  let plan = '';
  const r = input('Create a file named planned.txt containing the word done.', { place: place(), plan: true, askUser: async (q) => ((plan = (q as { plan?: string }).plan ?? ''), { kind: 'plan', approve: true }) });
  await backend.run(r);
  const { existsSync } = await import('node:fs');
  if (!plan) return 'no plan came to you';
  return existsSync(path.join(ws, 'planned.txt')) ? true : `not done after approval; plan: ${plan.slice(0, 120)}`;
});
await check('/compact: its own, a compact event, nothing said in the chat', async () => {
  const r = input('/compact', { place: place({ resume: first.sessions[0]! }) });
  await backend.run(r);
  const compact = r.events.find(([k]) => k === 'compact');
  const texts = r.events.filter(([k]) => k === 'text');
  return compact && !texts.length ? true : `compact ${compact?.[1]} texts ${texts.length}`;
});
await check('Steer Now: the running turn stops for a message, which is answered next', async () => {
  const steers: Array<Steer | undefined> = [];
  const r = input('Run the shell command `sleep 45` with your bash tool, then say done.', { place: place(), onSteer: (s) => void steers.push(s) });
  const running = backend.run(r);
  const until = Date.now() + 90_000;
  while (Date.now() < until && !Object.values(tools(r)).some((s) => s.status === 'running')) await new Promise((res) => setTimeout(res, 200));
  const steer = steers.at(-1);
  if (!steer) return 'no steer';
  let answered = '';
  const ok = await steer.interrupt!({ prompt: 'Reply with exactly: AFTER', requesterName: 'kayra', viaAgent: false, context: [], onEvent: () => undefined, onDone: (t) => void (answered = t), onError: (e) => void (answered = `error: ${e}`) }, 'Stopped to read your message');
  const first = await running;
  if (!ok) return 'interrupt said no';
  return first.includes('Stopped to read your message') && /AFTER/.test(answered) ? true : `run: ${first.slice(0, 120)} | next: ${answered}`;
});
await check('Stop: an aborted run ends within the time limit, its step ended', async () => {
  const abort = new AbortController();
  const r = input('Run the shell command `sleep 60` with your bash tool.', { place: place(), signal: abort.signal });
  const running = backend.run(r);
  const until = Date.now() + 90_000;
  while (Date.now() < until && !Object.values(tools(r)).some((s) => s.status === 'running')) await new Promise((res) => setTimeout(res, 200));
  const t = Date.now();
  abort.abort();
  const failed = await running.then(() => false, () => true);
  const last = Object.values(tools(r)).at(-1);
  return failed && Date.now() - t < 13_000 && last?.status === 'error' ? true : `rejected ${failed} in ${Date.now() - t}ms, last ${last?.status}`;
});
await check('/btw: a side question on a fork, with no tools, nothing kept', async () => {
  let streamed = '';
  const answer = await askOpenCodeBtw({ question: 'What text did the earlier command print? One line.', cwd: ws, resume: first.sessions[0]!, model: MODEL, signal: new AbortController().signal, onText: (t) => void (streamed = t) });
  return answer && streamed ? true : `answer: ${answer}`;
});
await check('a side call (naming a worktree) as Beluga’s own agent', async () => {
  const answer = await openCodeComplete({ prompt: 'Add a dark mode toggle to the settings page', system: 'Name a git branch for this task: 2 to 4 lowercase words joined by hyphens. Answer with the name only.', cwd: ws, model: MODEL });
  return /^[a-z0-9-]+$/.test(answer.trim()) ? true : `answer: ${answer}`;
});
await check('its models list (the picker)', async () => {
  const models = await backend.listModels!();
  return models && models.length > 0 && models.every((m) => m.value.includes('/')) ? true : JSON.stringify(models).slice(0, 200);
});

await host.close();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
