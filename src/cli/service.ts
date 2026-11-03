import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { belugaEnv } from '../core/beluga-env.js';
import { belugaHome } from '../core/home.js';
import { runningDaemon } from '../daemon/files.js';
import { type Exit, type Io, errorText } from './io.js';
import { tilde } from './paths.js';

/** launchd's name for it, after the Mac app's identifier. */
export const LAUNCHD_LABEL = 'io.github.kayraucklnc.beluga.server';
export const SYSTEMD_UNIT = 'beluga.service';

/** Run a program; resolves with what it printed and its exit code (127: it isn't there). */
export type Exec = (cmd: string, args: readonly string[]) => Promise<{ readonly code: number; readonly out: string }>;

export const exec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : (err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });

export interface ServiceEnv {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly uid: number;
  readonly user: string;
  /** The command that runs Beluga: the server install's launcher, else this Node and this cli.js. */
  readonly command: readonly string[];
  /** What the service sees: PATH (git, claude), and BELUGA_HOME when it's set. */
  readonly env: Readonly<Record<string, string>>;
  readonly exec: Exec;
}

export function serviceEnv(): ServiceEnv {
  const root = belugaEnv('SERVER_ROOT');
  const home = belugaEnv('HOME');
  return {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    user: os.userInfo().username,
    command: root ? [path.join(root, 'bin', 'beluga')] : [process.execPath, ...process.execArgv, realpathSync(process.argv[1]!)],
    env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...(home ? { BELUGA_HOME: home } : {}) },
    exec,
  };
}

const unitPath = (e: ServiceEnv): string => path.join(e.home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
const plistPath = (e: ServiceEnv): string => path.join(e.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
/** Where launchd puts what Beluga prints before its own log is open (its log is daemon.log, as always). */
const launchdLog = (): string => path.join(belugaHome(), 'logs', 'service.log');

/** systemd quotes: each word in "…", with \ and " escaped. */
const sdQuote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The systemd user unit: `beluga up --foreground`, started again if it fails, from boot (with linger). */
export function systemdUnit(e: ServiceEnv): string {
  return [
    '[Unit]',
    'Description=Beluga (Claude Code across your projects, from your phone)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${[...e.command, 'up', '--foreground'].map(sdQuote).join(' ')}`,
    ...Object.entries(e.env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`),
    // `beluga stop` ends it cleanly and it stays stopped; a crash starts it again.
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** The launchd agent: the same, at login on a Mac. */
export function launchdPlist(e: ServiceEnv): string {
  const strings = (xs: readonly string[]): string => xs.map((x) => `    <string>${xml(x)}</string>`).join('\n');
  const env = Object.entries(e.env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings([...e.command, 'up', '--foreground'])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(launchdLog())}</string>
  <key>StandardErrorPath</key>
  <string>${xml(launchdLog())}</string>
</dict>
</plist>
`;
}

/** Whether a service is installed for this user. */
export function serviceInstalled(e: ServiceEnv): boolean {
  if (e.platform === 'linux') return existsSync(unitPath(e));
  if (e.platform === 'darwin') return existsSync(plistPath(e));
  return false;
}

const unsupported = (e: ServiceEnv, io: Io): Exit => {
  io.err(`\`beluga service\` uses systemd on Linux and launchd on a Mac; on ${e.platform}, keep \`beluga up\` running another way.\n`);
  return 1;
};

/** Start the installed service (what `beluga up` does when there is one). Resolves with why it couldn't. */
export async function startService(e: ServiceEnv): Promise<string | undefined> {
  const r = e.platform === 'linux' ? await e.exec('systemctl', ['--user', 'start', SYSTEMD_UNIT]) : await e.exec('launchctl', ['kickstart', `gui/${e.uid}/${LAUNCHD_LABEL}`]);
  return r.code === 0 ? undefined : r.out || `exit ${r.code}`;
}

async function stopRunning(io: Io): Promise<void> {
  if (!runningDaemon()) return;
  io.err('Stopping the Beluga that runs now, so the service runs it from here on…\n');
  const { stop } = await import('./stop.js');
  await stop({ out: () => undefined, err: io.err });
}

/** Linux: from boot, and after you log out, only with lingering on. Tries; says how when it can't. */
async function linger(e: ServiceEnv, io: Io): Promise<void> {
  const now = await e.exec('loginctl', ['show-user', e.user, '--property=Linger']);
  if (/Linger=yes/.test(now.out)) return;
  if ((await e.exec('loginctl', ['enable-linger', e.user])).code === 0) {
    io.out('It starts when this computer does, before anyone logs in (lingering is on for you).\n');
    return;
  }
  io.out(`For it to start at boot and keep running after you log out, systemd needs lingering on for you:\n  sudo loginctl enable-linger ${e.user}\nUntil then it runs while you're logged in.\n`);
}

/** `beluga service install`. */
export async function installService(e: ServiceEnv, io: Io): Promise<Exit> {
  if (e.platform !== 'linux' && e.platform !== 'darwin') return unsupported(e, io);
  if (e.platform === 'linux') {
    const probe = await e.exec('systemctl', ['--user', 'show-environment']);
    if (probe.code !== 0) {
      io.err(`This computer has no systemd user session to keep Beluga in (${probe.code === 127 ? 'no systemctl' : probe.out.split('\n')[0] || 'systemctl --user failed'}).\nRun \`beluga up\` instead: it keeps running until the computer restarts. In a container, run \`beluga up --foreground\` as its command.\n`);
      return 1;
    }
    await stopRunning(io);
    mkdirSync(path.dirname(unitPath(e)), { recursive: true });
    writeFileSync(unitPath(e), systemdUnit(e));
    for (const args of [['daemon-reload'], ['enable', '--now', SYSTEMD_UNIT]]) {
      const r = await e.exec('systemctl', ['--user', ...args]);
      if (r.code !== 0) {
        io.err(`systemd didn't take it (systemctl --user ${args.join(' ')}: ${r.out || `exit ${r.code}`}).\n`);
        return 1;
      }
    }
    io.out(`Beluga runs as a systemd user service now (${tilde(unitPath(e), e.home)}), and starts again if it stops by itself.\n`);
    await linger(e, io);
  } else {
    await stopRunning(io);
    mkdirSync(path.dirname(plistPath(e)), { recursive: true });
    mkdirSync(path.dirname(launchdLog()), { recursive: true });
    writeFileSync(plistPath(e), launchdPlist(e));
    // Loaded fresh: an older copy goes first (bootout fails harmlessly when there's none).
    await e.exec('launchctl', ['bootout', `gui/${e.uid}/${LAUNCHD_LABEL}`]);
    const r = await e.exec('launchctl', ['bootstrap', `gui/${e.uid}`, plistPath(e)]);
    if (r.code !== 0) {
      io.err(`launchd didn't take it (${r.out || `exit ${r.code}`}). Logged in on this Mac's screen? launchd starts agents for a logged-in user.\n`);
      return 1;
    }
    io.out(`Beluga runs as a launchd agent now (${tilde(plistPath(e), e.home)}): it starts when you log in and again if it stops by itself.\nFor a Mac that restarts on its own (a Mac mini), turn on automatic login in System Settings › Users & Groups.\n`);
  }
  io.out('Its log is where it always is: `beluga logs -f`. `beluga service remove` takes it out.\n');
  return 0;
}

/** `beluga service remove`: stopped, and no longer started. */
export async function removeService(e: ServiceEnv, io: Io): Promise<Exit> {
  if (e.platform !== 'linux' && e.platform !== 'darwin') return unsupported(e, io);
  if (!serviceInstalled(e)) {
    io.out('No Beluga service is installed.\n');
    return 0;
  }
  try {
    if (e.platform === 'linux') {
      await e.exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
      rmSync(unitPath(e), { force: true });
      await e.exec('systemctl', ['--user', 'daemon-reload']);
    } else {
      await e.exec('launchctl', ['bootout', `gui/${e.uid}/${LAUNCHD_LABEL}`]);
      rmSync(plistPath(e), { force: true });
    }
  } catch (err) {
    io.err(`Couldn't remove it: ${errorText(err)}\n`);
    return 1;
  }
  io.out('Removed the Beluga service: Beluga stopped and won\'t start by itself. `beluga up` starts it by hand.\n');
  return 0;
}

/** `beluga service` (status): installed or not, and with what. */
export function serviceStatus(e: ServiceEnv, io: Io): Exit {
  if (!serviceInstalled(e)) {
    io.out('No service is installed: Beluga runs only when started. `beluga service install` keeps it running.\n');
    return 0;
  }
  io.out(`Installed as a ${e.platform === 'linux' ? `systemd user service (${tilde(unitPath(e), e.home)})` : `launchd agent (${tilde(plistPath(e), e.home)})`}. Beluga is ${runningDaemon() ? 'running' : 'not running: `beluga up` starts it'}.\n`);
  return 0;
}
