import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What a friend's Claude may look at on this Mac when you allow it (Settings › What your
 * friends' Claudes can do here): a screenshot of the main display or of one app's window, and a
 * summary of the device. Read-only, nothing secret: no serial numbers, MAC addresses, Wi-Fi
 * names, host names or anything from other apps. Everything the system is asked goes through
 * a SystemPort, so tests never touch the real screen.
 */

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecBytesResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface SystemPort {
  /** `env`: added to this process's own environment for that command. */
  exec(cmd: string, args: readonly string[], timeoutMs?: number, env?: Readonly<Record<string, string>>): Promise<ExecResult>;
  /** Like exec, but stdout/stderr are raw bytes (a screenshot, a file): used by adb exec-out (phone-adb.ts). */
  execBytes?(cmd: string, args: readonly string[], timeoutMs?: number): Promise<ExecBytesResult>;
  /** A long-running command's stdout as it comes (a phone's screen video over adb), until it ends or stop(). */
  stream?(cmd: string, args: readonly string[], onData: (chunk: Buffer) => void, onEnd: (code: number | null, stderr: string) => void): { stop(): void };
  readdir(dir: string): Promise<readonly string[]>;
  readonly os: Pick<typeof os, 'platform' | 'release' | 'cpus' | 'totalmem' | 'freemem' | 'networkInterfaces' | 'uptime' | 'arch' | 'homedir'>;
}

export const realSystem: SystemPort = {
  exec: (cmd, args, timeoutMs = 15_000, env) =>
    new Promise((resolve) => {
      execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? (err ? err.message : '') });
      });
    }),
  execBytes: (cmd, args, timeoutMs = 20_000) =>
    new Promise((resolve) => {
      execFile(cmd, [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: (stdout as Buffer) ?? Buffer.alloc(0), stderr: (stderr as Buffer) ?? Buffer.from(err ? err.message : '') });
      });
    }),
  stream: (cmd, args, onData, onEnd) => {
    const child = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let ended = false;
    const end = (code: number | null, why = ''): void => {
      if (ended) return;
      ended = true;
      onEnd(code, (stderr || why).trim().slice(0, 500));
    };
    child.stdout.on('data', (chunk: Buffer) => onData(chunk));
    child.stderr.on('data', (chunk: Buffer) => void (stderr.length < 2000 && (stderr += chunk.toString('utf8'))));
    child.on('error', (err) => end(null, err.message));
    child.on('close', (code) => end(code));
    return { stop: () => void child.kill('SIGTERM') };
  },
  readdir: (dir) => fs.readdir(dir).catch(() => []),
  os,
};

// ------------------------------------------------------------------ the screen

export interface WindowInfo {
  readonly id: number;
  readonly app: string;
  readonly title: string;
}

/** On-screen app windows, front to back (asked of CoreGraphics through JavaScript for Automation). */
const WINDOWS_JXA = `ObjC.import('CoreGraphics');
var raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
var list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
JSON.stringify(list.filter(function (w) { return w.kCGWindowLayer === 0; }).map(function (w) { return { id: w.kCGWindowNumber, app: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '' }; }));`;

/** On Windows: every process with a titled main window (its handle is the id). */
const WINDOWS_PS = `$ErrorActionPreference = 'Stop'
$w = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object { [pscustomobject]@{ id = [int64]$_.MainWindowHandle; app = $_.ProcessName; title = $_.MainWindowTitle } })
ConvertTo-Json -Compress -InputObject $w`;

/** PowerShell, without the user's profile or prompts (Windows). */
const powershell = (sys: SystemPort, script: string, timeoutMs?: number): Promise<ExecResult> => sys.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeoutMs);

/** A path inside a single-quoted PowerShell string. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export async function listWindows(sys: SystemPort): Promise<WindowInfo[]> {
  const platform = sys.os.platform();
  // Linux has no one way to list windows across X11 and Wayland: a window can't be picked there.
  if (platform !== 'darwin' && platform !== 'win32') return [];
  const res = platform === 'win32' ? await powershell(sys, WINDOWS_PS, 10_000) : await sys.exec('osascript', ['-l', 'JavaScript', '-e', WINDOWS_JXA], 10_000);
  if (res.code !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout.trim() || '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((w) => (w && typeof w === 'object' && typeof (w as WindowInfo).id === 'number' && typeof (w as WindowInfo).app === 'string' ? [{ id: (w as WindowInfo).id, app: (w as WindowInfo).app, title: String((w as WindowInfo).title ?? '').slice(0, 200) }] : []))
      : [];
  } catch {
    return [];
  }
}

export interface Screenshot {
  /** The full picture (PNG), in the task's folder. */
  readonly file: string;
  readonly bytes: number;
  /** A smaller JPEG for Claude to look at (missing: it couldn't be made). */
  readonly view?: string;
  /** What it shows: "the main display", "Safari's window". */
  readonly of: string;
}

const MAX_VIEW_BYTES = 3_500_000;

const VIEW_SIDE = 1568;

/**
 * Windows: the primary display (DPI-aware, so it's full size) or one window drawn by itself
 * (PrintWindow, so whatever covers it isn't in the picture). Saved as PNG to the given file.
 */
const shotPs = (file: string, hwnd?: number): string => `$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Runtime.InteropServices;
public static class BelugaShot {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L, T, R, B; }
  public static Bitmap Screen() {
    SetProcessDPIAware();
    var b = new Bitmap(GetSystemMetrics(0), GetSystemMetrics(1));
    using (var g = Graphics.FromImage(b)) g.CopyFromScreen(0, 0, 0, 0, b.Size);
    return b;
  }
  public static Bitmap Window(long h) {
    SetProcessDPIAware();
    Rect r; GetWindowRect(new IntPtr(h), out r);
    var b = new Bitmap(Math.Max(1, r.R - r.L), Math.Max(1, r.B - r.T));
    using (var g = Graphics.FromImage(b)) { var dc = g.GetHdc(); PrintWindow(new IntPtr(h), dc, 2); g.ReleaseHdc(dc); }
    return b;
  }
}
'@
$b = ${hwnd === undefined ? '[BelugaShot]::Screen()' : `[BelugaShot]::Window(${Math.trunc(hwnd)})`}
$b.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)`;

/** Linux: the first screenshot tool there is, Wayland's first, then GNOME's, KDE's, X11's. */
const LINUX_SHOTS = (file: string): ReadonlyArray<readonly [string, readonly string[]]> => [
  ['grim', [file]],
  ['gnome-screenshot', ['-f', file]],
  ['spectacle', ['-b', '-n', '-f', '-o', file]],
  ['scrot', ['-o', file]],
  ['import', ['-window', 'root', file]],
];

export interface DisplayLook {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This user's runtime folder (/run/user/<uid>) when there's no XDG_RUNTIME_DIR. */
  readonly runtimeDir?: string;
  readonly home: string;
  /** A folder's names, [] when it can't be read. */
  readonly list: (dir: string) => readonly string[];
  readonly exists: (file: string) => boolean;
}

/**
 * Linux: the desktop to take a screenshot of, when Beluga was started without one (a service, over
 * ssh, from a terminal on another tty): this user's Wayland socket, else the first X display and
 * its ~/.Xauthority. Nothing when the environment already names one, or none is found.
 */
export function linuxDisplayEnv(look: DisplayLook): Record<string, string> {
  const { env } = look;
  if (env.WAYLAND_DISPLAY || env.DISPLAY) return {};
  const runtime = env.XDG_RUNTIME_DIR ?? look.runtimeDir;
  const wayland = runtime ? look.list(runtime).filter((n) => /^wayland-\d+$/.test(n)).sort()[0] : undefined;
  if (wayland && runtime) return { WAYLAND_DISPLAY: wayland, ...(env.XDG_RUNTIME_DIR ? {} : { XDG_RUNTIME_DIR: runtime }) };
  const x = look.list('/tmp/.X11-unix').map((n) => /^X(\d+)$/.exec(n)?.[1]).filter((n): n is string => n !== undefined).sort((a, b) => Number(a) - Number(b))[0];
  if (x === undefined) return {};
  const auth = path.join(look.home, '.Xauthority');
  return { DISPLAY: `:${x}`, ...(!env.XAUTHORITY && look.exists(auth) ? { XAUTHORITY: auth } : {}) };
}

const realDisplayEnv = (sys: SystemPort): Record<string, string> =>
  linuxDisplayEnv({
    env: process.env,
    ...(typeof process.getuid === 'function' ? { runtimeDir: `/run/user/${process.getuid()}` } : {}),
    home: sys.os.homedir(),
    list: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    exists: existsSync,
  });

/** Every pixel the same (a screen that's off, asleep or locked away gives black): nothing to show. */
async function blank(file: string): Promise<boolean> {
  try {
    const { decodeImage } = await import('../../image/decode.js');
    const { data } = decodeImage(await fs.readFile(file), file, 64);
    for (let i = 4; i < data.length; i += 4) if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) return false;
    return data.length > 0;
  } catch {
    return false;
  }
}

/** Where to allow screenshots when one fails, per system. */
const SHOT_HINT: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'macOS may need Beluga allowed in System Settings › Privacy & Security › Screen Recording.',
  linux: 'Linux needs a screenshot tool: grim (Wayland), gnome-screenshot, spectacle, scrot or ImageMagick.',
  win32: 'Windows can only take one while you are signed in and the screen is unlocked.',
};

/** The smaller JPEG for Claude, made here when the system has no tool for it (sips is the Mac's). */
async function shrinkHere(file: string, view: string): Promise<boolean> {
  try {
    const [{ decodeImage }, { default: jpeg }] = await Promise.all([import('../../image/decode.js'), import('jpeg-js')]);
    const bmp = decodeImage(await fs.readFile(file), file, VIEW_SIDE);
    await fs.writeFile(view, jpeg.encode({ data: Buffer.from(bmp.data), width: bmp.width, height: bmp.height }, 70).data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take a screenshot without a sound: the main display, or the front window of one app (Mac and
 * Windows). Fails clearly when there's no screen to capture or the system hasn't allowed it.
 */
export async function captureScreen(sys: SystemPort, dir: string, opts: { app?: string } = {}): Promise<Screenshot> {
  const platform = sys.os.platform();
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') throw new Error(`Screenshots don't work on ${platform}`);
  if (opts.app && platform === 'linux') throw new Error("One app's window can't be picked on Linux: take the whole screen instead");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  let win: WindowInfo | undefined;
  if (opts.app) {
    const wanted = opts.app.trim().toLowerCase();
    const windows = await listWindows(sys);
    win = windows.find((w) => w.app.toLowerCase() === wanted) ?? windows.find((w) => w.app.toLowerCase().includes(wanted));
    if (!win) throw new Error(`No open window of ${opts.app} on screen`);
  }
  const of = win ? `${win.app}'s window` : 'the main display';
  const file = path.join(dir, `screen-${stamp}${opts.app ? `-${opts.app.replace(/[^\w-]+/g, '_').slice(0, 30)}` : ''}.png`);
  let res: ExecResult;
  if (platform === 'darwin') res = await sys.exec('screencapture', ['-x', '-t', 'png', ...(win ? [`-l${win.id}`, '-o'] : ['-m']), file], 20_000);
  else if (platform === 'win32') res = await powershell(sys, shotPs(file, win?.id), 20_000);
  else {
    res = { code: 1, stdout: '', stderr: '' };
    const env = realDisplayEnv(sys);
    for (const [cmd, args] of LINUX_SHOTS(file)) {
      res = await sys.exec(cmd, args, 20_000, env);
      if (res.code === 0 && (await fs.stat(file).catch(() => undefined))?.size) break;
    }
  }
  const stat = await fs.stat(file).catch(() => undefined);
  if (res.code !== 0 || !stat?.size) {
    throw new Error(`The screenshot didn't work${res.stderr.trim() ? `: ${res.stderr.trim().slice(0, 200)}` : ''}. ${SHOT_HINT[platform]}`);
  }
  if (platform === 'linux' && (await blank(file))) {
    await fs.rm(file, { force: true });
    throw new Error('The screenshot came out blank: the screen is off, asleep or locked (a closed lid, a monitor that went to sleep). Wake it and try again.');
  }
  // A smaller copy for Claude's eyes (the PNG of a Retina display is several MB).
  const view = file.replace(/\.png$/, '-view.jpg');
  const shrunk = platform === 'darwin' ? (await sys.exec('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', String(VIEW_SIDE), file, '--out', view], 20_000)).code === 0 : await shrinkHere(file, view);
  const viewStat = shrunk ? await fs.stat(view).catch(() => undefined) : undefined;
  return { file, bytes: stat.size, of, ...(viewStat?.size && viewStat.size <= MAX_VIEW_BYTES ? { view } : stat.size <= MAX_VIEW_BYTES ? { view: file } : {}) };
}

// ------------------------------------------------------------------ the device

export interface DeviceInfo {
  readonly os: string;
  readonly model?: string;
  readonly chip?: string;
  readonly cpus: number;
  readonly arch: string;
  readonly memory: { readonly totalGB: number; readonly freeGB: number };
  readonly disk?: { readonly totalGB: number; readonly freeGB: number };
  readonly battery?: { readonly percent?: number; readonly charging?: boolean; readonly power: string; readonly remaining?: string };
  readonly uptimeHours: number;
  readonly network: ReadonlyArray<{ readonly interface: string; readonly addresses: readonly string[] }>;
  readonly apps: readonly string[];
  /** Which kind of computer (missing: a Mac, from before Linux and Windows). */
  readonly where?: 'mac' | 'windows' | 'linux';
}

const GB = 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** `df -k` output → total and free space of its first volume. */
export function parseDf(text: string): { totalGB: number; freeGB: number } | undefined {
  const line = text.trim().split('\n')[1];
  const cols = line?.trim().split(/\s+/);
  const total = Number(cols?.[1]);
  const free = Number(cols?.[3]);
  return Number.isFinite(total) && Number.isFinite(free) && total > 0 ? { totalGB: round1((total * 1024) / GB), freeGB: round1((free * 1024) / GB) } : undefined;
}

/** `pmset -g batt` output → the battery, or undefined on a Mac without one. */
export function parseBattery(text: string): DeviceInfo['battery'] {
  const power = /drawing from '([^']+)'/.exec(text)?.[1];
  const line = text.split('\n').find((l) => /InternalBattery/.test(l));
  if (!line) return undefined;
  const percent = Number(/(\d+)%/.exec(line)?.[1]);
  const state = /;\s*([a-zA-Z ]+);/.exec(line)?.[1]?.trim();
  const remaining = /(\d+:\d+) remaining/.exec(line)?.[1];
  return { power: power ?? 'unknown', ...(Number.isFinite(percent) ? { percent } : {}), ...(state ? { charging: state === 'charging' || state === 'charged' || state === 'finishing charge' } : {}), ...(remaining ? { remaining } : {}) };
}

/** Local addresses by interface (no MAC addresses, nothing from outside this Mac). */
export function localNetwork(ifaces: ReturnType<typeof os.networkInterfaces>): DeviceInfo['network'] {
  return Object.entries(ifaces)
    .flatMap(([name, list]) => {
      const addresses = (list ?? []).filter((a) => !a.internal && !(a.family === 'IPv6' && a.address.startsWith('fe80'))).map((a) => a.address);
      return addresses.length ? [{ interface: name, addresses }] : [];
    })
    .slice(0, 12);
}

/** What the system says beyond what Node knows: the same fields for every platform. */
interface SystemFacts {
  readonly os?: string;
  readonly model?: string;
  readonly chip?: string;
  readonly disk?: DeviceInfo['disk'];
  readonly battery?: DeviceInfo['battery'];
  readonly apps: readonly string[];
}

/** `/etc/os-release` → "Ubuntu 24.04.1 LTS". */
export function parseOsRelease(text: string): string | undefined {
  const line = text.split('\n').find((l) => l.startsWith('PRETTY_NAME='));
  return line?.slice('PRETTY_NAME='.length).trim().replace(/^"(.*)"$/, '$1') || undefined;
}

/** Linux: os-release, the DMI product name, `df`, /sys's battery and the launcher's apps. */
async function linuxFacts(sys: SystemPort): Promise<SystemFacts> {
  const home = sys.os.homedir();
  const [release, product, df, capacity, status, online, shared, local] = await Promise.all([
    sys.exec('cat', ['/etc/os-release']),
    sys.exec('cat', ['/sys/devices/virtual/dmi/id/product_name']),
    sys.exec('df', ['-k', home]),
    sys.exec('cat', ['/sys/class/power_supply/BAT0/capacity']),
    sys.exec('cat', ['/sys/class/power_supply/BAT0/status']),
    sys.exec('cat', ['/sys/class/power_supply/AC/online']),
    sys.readdir('/usr/share/applications'),
    sys.readdir(path.join(home, '.local/share/applications')),
  ]);
  const percent = capacity.code === 0 ? Number(capacity.stdout.trim()) : NaN;
  const state = status.code === 0 ? status.stdout.trim().toLowerCase() : '';
  const model = product.code === 0 ? product.stdout.trim() : '';
  return {
    os: release.code === 0 ? parseOsRelease(release.stdout) : undefined,
    // "System Product Name" and the like are what boards say when they have no name.
    ...(model && !/system product name|to be filled|default string/i.test(model) ? { model } : {}),
    ...(df.code === 0 ? { disk: parseDf(df.stdout) } : {}),
    ...(Number.isFinite(percent)
      ? { battery: { power: online.code === 0 ? (online.stdout.trim() === '1' ? 'AC Power' : 'Battery Power') : 'unknown', percent, ...(state ? { charging: state === 'charging' || state === 'full' } : {}) } }
      : {}),
    apps: [...shared, ...local].filter((n) => n.endsWith('.desktop')).map((n) => n.slice(0, -'.desktop'.length).replace(/^org\.|^com\./, '')),
  };
}

/** Windows: one PowerShell call for the version, model, C: drive and battery (never the serial). */
const WINDOWS_FACTS_PS = `$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ os = $os.Caption; build = $os.BuildNumber; model = $cs.Model; maker = $cs.Manufacturer; chip = $cpu.Name; size = $d.Size; free = $d.FreeSpace; percent = $b.EstimatedChargeRemaining; status = $b.BatteryStatus; minutes = $b.EstimatedRunTime })`;

/** What WINDOWS_FACTS_PS printed → the shared fields. */
export function parseWindowsFacts(text: string): Omit<SystemFacts, 'apps'> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.trim()) as Record<string, unknown>;
  } catch {
    return {};
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const size = num(raw.size);
  const free = num(raw.free);
  const percent = num(raw.percent);
  // BatteryStatus 2 is "on AC"; 6 to 9 are kinds of charging. EstimatedRunTime 71582788 means "on AC".
  const status = num(raw.status);
  const minutes = num(raw.minutes);
  const model = [str(raw.maker), str(raw.model)].filter((s): s is string => Boolean(s) && !/to be filled|system product name|default string/i.test(s!)).join(' ');
  return {
    ...(str(raw.os) ? { os: `${str(raw.os)}${str(raw.build) ? ` (build ${str(raw.build)})` : ''}` } : {}),
    ...(model ? { model } : {}),
    ...(str(raw.chip) ? { chip: str(raw.chip) } : {}),
    ...(size && free !== undefined ? { disk: { totalGB: round1(size / GB), freeGB: round1(free / GB) } } : {}),
    ...(percent !== undefined
      ? {
          battery: {
            power: status === 2 || (status !== undefined && status >= 6 && status <= 9) ? 'AC Power' : 'Battery Power',
            percent,
            ...(status !== undefined ? { charging: status >= 6 && status <= 9 } : {}),
            ...(minutes !== undefined && minutes < 71582788 ? { remaining: `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}` } : {}),
          },
        }
      : {}),
  };
}

async function windowsFacts(sys: SystemPort): Promise<SystemFacts> {
  const menu = (root: string): Promise<readonly string[]> => sys.readdir(path.join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  const [facts, common, mine] = await Promise.all([
    powershell(sys, WINDOWS_FACTS_PS, 20_000),
    menu(process.env.ProgramData ?? 'C:\\ProgramData'),
    menu(process.env.APPDATA ?? path.join(sys.os.homedir(), 'AppData', 'Roaming')),
  ]);
  return { ...(facts.code === 0 ? parseWindowsFacts(facts.stdout) : {}), apps: [...common, ...mine].filter((n) => n.endsWith('.lnk')).map((n) => n.slice(0, -'.lnk'.length)) };
}

/** macOS: sw_vers, the hardware report (model and chip only), the data volume, pmset and /Applications. */
async function macFacts(sys: SystemPort): Promise<SystemFacts> {
  const [ver, build, hw, df, batt, apps, userApps] = await Promise.all([
    sys.exec('sw_vers', ['-productVersion']),
    sys.exec('sw_vers', ['-buildVersion']),
    sys.exec('system_profiler', ['-json', 'SPHardwareDataType'], 20_000),
    sys.exec('df', ['-k', '/System/Volumes/Data']),
    sys.exec('pmset', ['-g', 'batt']),
    sys.readdir('/Applications'),
    sys.readdir(path.join(sys.os.homedir(), 'Applications')),
  ]);
  let model: string | undefined;
  let chip: string | undefined;
  try {
    // Only the model and chip: the same report holds the serial number, which stays here.
    const item = (JSON.parse(hw.stdout) as { SPHardwareDataType?: Array<Record<string, unknown>> }).SPHardwareDataType?.[0] ?? {};
    model = typeof item.machine_name === 'string' ? item.machine_name : undefined;
    chip = typeof item.chip_type === 'string' ? item.chip_type : typeof item.cpu_type === 'string' ? item.cpu_type : undefined;
  } catch {
    // No profiler output: the processor's name below still says a lot.
  }
  const version = ver.code === 0 ? ver.stdout.trim() : '';
  const disk = df.code === 0 ? parseDf(df.stdout) : undefined;
  const battery = batt.code === 0 ? parseBattery(batt.stdout) : undefined;
  return {
    ...(version ? { os: `macOS ${version}${build.code === 0 && build.stdout.trim() ? ` (${build.stdout.trim()})` : ''}` } : {}),
    ...(model ? { model } : {}),
    ...(chip ? { chip } : {}),
    ...(disk ? { disk } : {}),
    ...(battery ? { battery } : {}),
    apps: [...apps, ...userApps].filter((n) => n.endsWith('.app')).map((n) => n.slice(0, -4)),
  };
}

/** A summary of this computer: what a friend's Claude may read with the device capability. */
export async function deviceInfo(sys: SystemPort): Promise<DeviceInfo> {
  const platform = sys.os.platform();
  const facts = await (platform === 'darwin' ? macFacts(sys) : platform === 'win32' ? windowsFacts(sys) : platform === 'linux' ? linuxFacts(sys) : Promise.resolve<SystemFacts>({ apps: [] }));
  const { model, disk, battery } = facts;
  const cpus = sys.os.cpus();
  const chip = facts.chip ?? cpus[0]?.model;
  return {
    os: facts.os ?? `${platform} ${sys.os.release()}`,
    ...(model ? { model } : {}),
    ...(chip ? { chip } : {}),
    cpus: cpus.length,
    arch: sys.os.arch(),
    memory: { totalGB: round1(sys.os.totalmem() / GB), freeGB: round1(sys.os.freemem() / GB) },
    ...(disk ? { disk } : {}),
    ...(battery ? { battery } : {}),
    uptimeHours: round1(sys.os.uptime() / 3600),
    network: localNetwork(sys.os.networkInterfaces()),
    apps: [...new Set(facts.apps)].sort((a, b) => a.localeCompare(b)).slice(0, 300),
    where: platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux',
  };
}

/** The same in a few lines (what Claude reads first). */
export function describeDevice(d: DeviceInfo): string {
  const lines = [
    `${d.model ?? (d.where === 'windows' ? 'Windows PC' : d.where === 'linux' ? 'Linux computer' : 'Mac')}${d.chip ? ` · ${d.chip}` : ''} · ${d.cpus} cores · ${d.memory.totalGB} GB memory (${d.memory.freeGB} GB free)`,
    `${d.os}, up ${d.uptimeHours} h`,
    d.disk ? `Disk: ${d.disk.freeGB} GB free of ${d.disk.totalGB} GB` : '',
    d.battery ? `Battery: ${d.battery.percent ?? '?'}%${d.battery.charging ? ', charging' : ''} (${d.battery.power}${d.battery.remaining ? `, ${d.battery.remaining} left` : ''})` : 'No battery (or not reported)',
    d.network.length ? `Network: ${d.network.map((n) => `${n.interface} ${n.addresses.join(', ')}`).join('; ')}` : 'Network: no local addresses',
    `${d.apps.length} apps ${d.where === 'windows' ? 'in the Start menu' : d.where === 'linux' ? 'in the app launcher' : 'in /Applications'}${d.apps.length ? `: ${d.apps.slice(0, 40).join(', ')}${d.apps.length > 40 ? ', …' : ''}` : ''}`,
  ];
  return lines.filter(Boolean).join('\n');
}
