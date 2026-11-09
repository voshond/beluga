import { execFile } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * The ports a worktree's processes listen on (BLG-801): its dev servers, named by what they are
 * (vite, next, rails…), for the Ports tab and for forwarding a computer's servers to this Mac.
 *
 * A worktree's processes: those that carry its tag (Beluga gives its runs BELUGA_WORKTREE, and what
 * they start inherits it, see test-procs.ts), and those working in its folder (a dev server you
 * started in its terminal). Listening TCP sockets come from lsof on macOS, /proc/net/tcp on
 * Linux and PowerShell on Windows; only your own processes are seen. Windows can't tell another
 * process's folder or environment, so there a process is the worktree's when its command line, or
 * one of its parents', names a path inside it (npm's shims always run a dev server by its full path).
 */

export interface WorktreePort {
  readonly port: number;
  readonly pid: number;
  /** What it is, in a word: vite, next, rails, node… */
  readonly name: string;
  /** Where it listens: 127.0.0.1, ::1, or 0.0.0.0 / :: for every address. */
  readonly host: string;
}

/** A process listening on a port, before it's known whose it is. */
export interface Listener {
  readonly pid: number;
  readonly port: number;
  readonly host: string;
  /** Its program's name (lsof's c; on Linux argv[0], as node calls its main thread MainThread). */
  readonly comm: string;
}

/** What tells whose a process is: its environment, its folder, its command line. */
export interface ProcFacts {
  readonly env: string;
  readonly cwd?: string;
  readonly cmdline: string;
  /** Windows: the command lines of it and its parents, nearest first. */
  readonly lineage?: readonly string[];
}

/** Every listener now, with its process's facts (one look at the OS). */
export interface PortScan {
  readonly listeners: readonly Listener[];
  readonly facts: ReadonlyMap<number, ProcFacts>;
}

/** lsof -nP -iTCP -sTCP:LISTEN -Fpcn → each listener (the same port on two fds or addresses once per address). */
export function parseLsof(out: string): Listener[] {
  const found: Listener[] = [];
  let pid = 0;
  let comm = '';
  for (const line of out.split('\n')) {
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') pid = Number(value);
    else if (tag === 'c') comm = value;
    else if (tag === 'n') {
      const m = /^(.*):(\d+)$/.exec(value);
      if (!m || !pid) continue;
      const host = m[1] === '*' ? '0.0.0.0' : m[1]!.replace(/^\[(.*)\]$/, '$1');
      const port = Number(m[2]);
      if (!found.some((f) => f.pid === pid && f.port === port && f.host === host)) found.push({ pid, port, host, comm });
    }
  }
  return found;
}

/** A /proc/net/tcp or tcp6 address ("0100007F:0BB8") → host and port. */
function procAddress(hex: string): { host: string; port: number } | undefined {
  const [ip, port] = hex.split(':');
  if (!ip || !port) return undefined;
  // IPv4: little-endian bytes. IPv6: four little-endian 32-bit words.
  if (ip.length === 8) return { host: [3, 2, 1, 0].map((i) => parseInt(ip.slice(i * 2, i * 2 + 2), 16)).join('.'), port: parseInt(port, 16) };
  const words = [0, 1, 2, 3].map((w) => ip.slice(w * 8, w * 8 + 8).match(/../g)!.reverse().join(''));
  return { host: v6Text(words.flatMap((w) => [parseInt(w.slice(0, 4), 16), parseInt(w.slice(4), 16)])), port: parseInt(port, 16) };
}

/** Eight 16-bit groups → "::1", "::", and "::ffff:127.0.0.1" read as 127.0.0.1. */
function v6Text(groups: readonly number[]): string {
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join('.');
  // The longest run of zero groups (two or more) is written ::.
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len) best = { at: i, len: j - i };
    i = j === i ? i + 1 : j;
  }
  const hex = groups.map((g) => g.toString(16));
  return best.len < 2 ? hex.join(':') : `${hex.slice(0, best.at).join(':')}::${hex.slice(best.at + best.len).join(':')}`;
}

/** /proc/net/tcp(6) text → the listening sockets, by inode. */
export function parseProcNetTcp(text: string): Array<{ inode: number; host: string; port: number }> {
  const out: Array<{ inode: number; host: string; port: number }> = [];
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    // sl local rem st tx:rx tr:when retrnsmt uid timeout inode
    if (cols.length < 10 || cols[3] !== '0A') continue;
    const addr = procAddress(cols[1]!);
    const inode = Number(cols[9]);
    if (addr && inode) out.push({ inode, ...addr });
  }
  return out;
}

/** The dev servers worth a word of their own, by what their command line says ('': its own program's name). */
const KNOWN: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|[\s/])vite(\.[cm]?js)?(\s|$)|node_modules\/vite\//, 'vite'],
  [/(^|[\s/])next(\s|$)|node_modules\/next\/|next-server|next dev/, 'next'],
  [/(^|[\s/])astro(\s|$)|node_modules\/astro\//, 'astro'],
  [/(^|[\s/])nuxt(i)?(\s|$)|node_modules\/nuxt\//, 'nuxt'],
  [/remix(-serve)?(\s|$)|node_modules\/@remix-run\//, 'remix'],
  [/storybook/, 'storybook'],
  [/webpack(-dev-server)?(\s|$)|webpack-dev-server/, 'webpack'],
  [/(^|[\s/])expo(\s|$)|@expo\/cli|metro/, 'expo'],
  [/wrangler/, 'wrangler'],
  [/(^|[\s/])rails\s+(s|server)\b|puma|unicorn/, 'rails'],
  [/manage\.py\s+runserver/, 'django'],
  [/(^|[\s/])flask(\s|$)/, 'flask'],
  [/uvicorn/, 'uvicorn'],
  [/gunicorn/, 'gunicorn'],
  [/(^|[\s/])bun(\s|$)/, 'bun'],
  [/(^|[\s/])deno(\s|$)/, 'deno'],
  [/(^|[\s/])(postgres|redis-server|mysqld|mongod)(\s|$)/, ''],
];

/** A listener's name: a known dev server by its command line, else its program. */
export function nameOf(cmdline: string, comm: string): string {
  // Windows writes its paths with backslashes, and quotes them.
  const line = cmdline.replace(/\\/g, '/').replace(/"/g, '');
  for (const [re, name] of KNOWN) if (re.test(line)) return name || path.basename(comm).replace(/\.exe$/i, '');
  return path.basename(comm || cmdline.split(/\s/)[0] || '').replace(/\.exe$/i, '') || 'server';
}

/** A path, or `dir` itself, is inside `dir` (either slash, as Windows takes both). */
function within(p: string, dir: string): boolean {
  return p === dir || (p.startsWith(dir) && (p[dir.length] === '/' || p[dir.length] === '\\'));
}

/** A command line names a path inside `dir` (Windows: any case, either slash, quoted or not). */
function names(line: string, dir: string): boolean {
  const flat = (t: string): string => t.toLowerCase().replace(/\\/g, '/');
  const text = flat(line);
  const d = flat(dir);
  for (let at = text.indexOf(d); at >= 0; at = text.indexOf(d, at + 1)) {
    const before = text[at - 1];
    const after = text[at + d.length];
    if ((before === undefined || before === ' ' || before === '"' || before === "'") && (after === undefined || after === '/' || after === ' ' || after === '"' || after === "'")) return true;
  }
  return false;
}

/** The process carries the worktree's tag, or works in its folder. */
export function belongsTo(facts: ProcFacts, dir: string): boolean {
  const tagged = ['BELUGA_WORKTREE', 'KLAUD_WORKTREE'].some((key) => facts.env.includes(`${key}=${dir}\0`) || facts.env.endsWith(`${key}=${dir}`) || facts.env.includes(` ${key}=${dir} `));
  const working = Boolean(facts.cwd && within(facts.cwd, dir));
  const started = Boolean(facts.lineage?.some((line) => names(line, dir)));
  return tagged || working || started;
}

/** Listeners and their processes' facts → the worktree's ports, one row a port, lowest first. */
export function portsOf(listeners: readonly Listener[], facts: ReadonlyMap<number, ProcFacts>, dir: string): WorktreePort[] {
  // An absolute folder as given (a POSIX or a Windows one, wherever it is read), without a trailing slash.
  const root = path.posix.isAbsolute(dir) || path.win32.isAbsolute(dir) ? dir.replace(/(.)[\\/]+$/, '$1') : path.resolve(dir);
  const byPort = new Map<number, WorktreePort>();
  for (const l of listeners) {
    const f = facts.get(l.pid);
    if (!f || !belongsTo(f, root)) continue;
    const had = byPort.get(l.port);
    // One port on 127.0.0.1 and ::1 is one row; a loopback address says more than a wildcard.
    if (had && !(had.host.startsWith('0.') || had.host === '::')) continue;
    byPort.set(l.port, { port: l.port, pid: l.pid, name: nameOf(f.cmdline, l.comm), host: l.host });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function run(cmd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(cmd, [...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (_err, out) => resolve(out ?? ''));
    child.stdin?.end();
  });
}

const NONE: PortScan = { listeners: [], facts: new Map() };

/** macOS: lsof for the listeners, ps -E for their environment, lsof again for their folders. */
async function macScan(): Promise<PortScan> {
  const listeners = parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']));
  if (!listeners.length) return NONE;
  const list = [...new Set(listeners.map((l) => l.pid))].join(',');
  const [envOut, cmdOut, cwdOut] = await Promise.all([run('ps', ['-wwE', '-o', 'pid=,command=', '-p', list]), run('ps', ['-ww', '-o', 'pid=,command=', '-p', list]), run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', list])]);
  const rows = (out: string): Map<number, string> =>
    new Map(
      out.split('\n').flatMap((line) => {
        const m = /^\s*(\d+)\s(.*)$/.exec(line);
        return m ? [[Number(m[1]), m[2]!] as const] : [];
      }),
    );
  const cmds = rows(cmdOut);
  const facts = new Map<number, ProcFacts>();
  // ps -E prints the command, then its environment, space-separated: the tag is looked for between spaces.
  for (const [pid, line] of rows(envOut)) facts.set(pid, { env: ` ${line} `, cmdline: cmds.get(pid) ?? line });
  let pid = 0;
  for (const line of cwdOut.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && facts.has(pid)) facts.set(pid, { ...facts.get(pid)!, cwd: line.slice(1) });
  }
  return { listeners, facts };
}

/** Linux: /proc/net/tcp(6) for the listeners, each process's fds for whose socket it is. */
async function linuxScan(proc = '/proc'): Promise<PortScan> {
  const read = (file: string): Promise<string> => readFile(path.join(proc, file), 'utf8').catch(() => '');
  const sockets = [...parseProcNetTcp(await read('net/tcp')), ...parseProcNetTcp(await read('net/tcp6'))];
  if (!sockets.length) return NONE;
  const byInode = new Map(sockets.map((s) => [s.inode, s]));
  const listeners: Listener[] = [];
  const facts = new Map<number, ProcFacts>();
  for (const p of (await readdir(proc).catch(() => [] as string[])).filter((d) => /^\d+$/.test(d))) {
    const mine: Array<Omit<Listener, 'comm'>> = [];
    for (const fd of await readdir(path.join(proc, p, 'fd')).catch(() => [] as string[])) {
      const inode = /^socket:\[(\d+)\]$/.exec(await readlink(path.join(proc, p, 'fd', fd)).catch(() => ''))?.[1];
      const s = inode ? byInode.get(Number(inode)) : undefined;
      if (s && !mine.some((l) => l.port === s.port && l.host === s.host)) mine.push({ pid: Number(p), port: s.port, host: s.host });
    }
    if (!mine.length) continue;
    const [comm, cmdline, env, cwd] = await Promise.all([read(`${p}/comm`), read(`${p}/cmdline`), read(`${p}/environ`), readlink(path.join(proc, p, 'cwd')).catch(() => undefined)]);
    const program = path.basename(cmdline.split('\0')[0] ?? '') || comm.trim();
    listeners.push(...mine.map((l) => ({ ...l, comm: program })));
    facts.set(Number(p), { env: `${env}\0`, cmdline: cmdline.split('\0').join(' ').trim(), ...(cwd ? { cwd } : {}) });
  }
  return { listeners, facts };
}

/** Windows: the listeners and every process, with its parent and command line, as JSON. */
export const WINDOWS_SCAN = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$l = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess)',
  '$p = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine)',
  'ConvertTo-Json -Compress -Depth 3 @{ listeners = $l; procs = $p }',
].join('; ');

interface WindowsProc {
  readonly ProcessId?: number;
  readonly ParentProcessId?: number;
  readonly Name?: string;
  readonly CommandLine?: string | null;
}

/** WINDOWS_SCAN's JSON → the listeners and their processes' facts (each with its parents' command lines). */
export function parseWindowsScan(json: string): PortScan {
  let data: { listeners?: unknown; procs?: unknown };
  try {
    data = JSON.parse(json.replace(/^\uFEFF/, '')) as typeof data;
  } catch {
    return NONE;
  }
  // ConvertTo-Json writes a list of one as the one itself.
  const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === 'object' ? [v as T] : []);
  const procs = new Map(list<WindowsProc>(data.procs).flatMap((p) => (typeof p.ProcessId === 'number' ? [[p.ProcessId, p] as const] : [])));
  const listeners: Listener[] = [];
  for (const l of list<{ LocalAddress?: string; LocalPort?: number; OwningProcess?: number }>(data.listeners)) {
    const pid = l.OwningProcess;
    const port = l.LocalPort;
    if (typeof pid !== 'number' || !pid || typeof port !== 'number' || !port) continue;
    const host = l.LocalAddress || '0.0.0.0';
    if (!listeners.some((x) => x.pid === pid && x.port === port && x.host === host)) listeners.push({ pid, port, host, comm: procs.get(pid)?.Name ?? '' });
  }
  const facts = new Map<number, ProcFacts>();
  for (const pid of new Set(listeners.map((l) => l.pid))) {
    const own = procs.get(pid);
    const lineage: string[] = [];
    const seen = new Set<number>();
    // Its parents, nearest first, while they're there (a pid Windows reused is cut off by the cycle check).
    for (let p = own; p && typeof p.ProcessId === 'number' && !seen.has(p.ProcessId) && lineage.length < 8; p = p.ParentProcessId ? procs.get(p.ParentProcessId) : undefined) {
      seen.add(p.ProcessId);
      if (p.CommandLine) lineage.push(p.CommandLine);
    }
    facts.set(pid, { env: '', cmdline: own?.CommandLine ?? own?.Name ?? '', lineage });
  }
  return { listeners, facts };
}

async function windowsScan(): Promise<PortScan> {
  return parseWindowsScan(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCAN]));
}

/** Every listener now, and whose. */
export function scanPorts(platform: NodeJS.Platform = process.platform): Promise<PortScan> {
  if (platform === 'darwin') return macScan();
  if (platform === 'linux') return linuxScan();
  if (platform === 'win32') return windowsScan();
  return Promise.resolve(NONE);
}

/** The ports a worktree's processes listen on now. */
export async function worktreePorts(dir: string, platform: NodeJS.Platform = process.platform): Promise<WorktreePort[]> {
  const { listeners, facts } = await scanPorts(platform);
  return portsOf(listeners, facts, dir);
}

/**
 * Several folders' ports from one look at the OS. A port goes to the deepest folder it belongs to
 * (a worktree inside a project's folder keeps its own).
 */
export async function portsByFolder(dirs: readonly string[], platform: NodeJS.Platform = process.platform): Promise<Map<string, WorktreePort[]>> {
  const { listeners, facts } = await scanPorts(platform);
  const out = new Map<string, WorktreePort[]>();
  const taken = new Set<number>();
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    const ports = portsOf(listeners, facts, dir).filter((p) => !taken.has(p.port));
    for (const p of ports) taken.add(p.port);
    out.set(dir, ports);
  }
  return out;
}
