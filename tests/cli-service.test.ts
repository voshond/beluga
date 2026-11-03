import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Io } from '../src/cli/io.js';
import { type Exec, LAUNCHD_LABEL, type ServiceEnv, installService, launchdPlist, removeService, serviceInstalled, serviceStatus, startService, systemdUnit } from '../src/cli/service.js';

function capture(): Io & { readonly text: () => string; readonly errors: () => string } {
  let out = '';
  let err = '';
  return { out: (t) => void (out += t), err: (t) => void (err += t), text: () => out, errors: () => err };
}

/** systemctl, loginctl and launchctl as a test says they answer; every call is kept. */
function fakeExec(answers: Record<string, { code: number; out?: string }> = {}): Exec & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (cmd: string, args: readonly string[]) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const hit = Object.entries(answers).find(([k]) => line.startsWith(k));
    return { code: hit?.[1].code ?? 0, out: hit?.[1].out ?? '' };
  }) as Exec & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const envFor = (platform: NodeJS.Platform, exec: Exec): ServiceEnv => ({
  platform,
  home: mkdtempSync(path.join(os.tmpdir(), 'beluga-service-home-')),
  uid: 501,
  user: 'kay',
  command: ['/home/kay/.beluga/server/bin/beluga'],
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', BELUGA_HOME: '/data/beluga' },
  exec,
});

describe('the service files', () => {
  it('a systemd user unit runs `beluga up --foreground`, again only after a failure', () => {
    const unit = systemdUnit({ ...envFor('linux', fakeExec()), command: ['/opt/my "odd" dir/beluga'] });
    expect(unit).toContain('ExecStart="/opt/my \\"odd\\" dir/beluga" "up" "--foreground"');
    expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
    expect(unit).toContain('Environment="BELUGA_HOME=/data/beluga"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('a launchd agent does the same at login on a Mac', () => {
    const plist = launchdPlist({ ...envFor('darwin', fakeExec()), env: { PATH: '/a&b' } });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toMatch(/<string>\/home\/kay\/.beluga\/server\/bin\/beluga<\/string>\s*<string>up<\/string>\s*<string>--foreground<\/string>/);
    expect(plist).toContain('<string>/a&amp;b</string>');
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain('service.log');
  });
});

describe('beluga service on Linux', () => {
  it('installs, enables and starts it, and says how to keep it after logout', async () => {
    const exec = fakeExec({ 'loginctl show-user': { code: 0, out: 'Linger=no' }, 'loginctl enable-linger': { code: 1, out: 'Access denied' } });
    const e = envFor('linux', exec);
    const io = capture();
    expect(await installService(e, io)).toBe(0);
    const unit = path.join(e.home, '.config/systemd/user/beluga.service');
    expect(readFileSync(unit, 'utf8')).toContain('up" "--foreground"');
    expect(exec.calls).toEqual(['systemctl --user show-environment', 'systemctl --user daemon-reload', 'systemctl --user enable --now beluga.service', 'loginctl show-user kay --property=Linger', 'loginctl enable-linger kay']);
    expect(io.text()).toContain('systemd user service');
    expect(io.text()).toContain('sudo loginctl enable-linger kay');
    expect(io.text()).toContain('beluga logs -f');
    expect(serviceInstalled(e)).toBe(true);
    const status = capture();
    serviceStatus(e, status);
    expect(status.text()).toContain('systemd user service');

    expect(await startService(e)).toBeUndefined();
    expect(exec.calls.at(-1)).toBe('systemctl --user start beluga.service');

    const gone = capture();
    expect(await removeService(e, gone)).toBe(0);
    expect(existsSync(unit)).toBe(false);
    expect(exec.calls.slice(-2)).toEqual(['systemctl --user disable --now beluga.service', 'systemctl --user daemon-reload']);
    expect(gone.text()).toContain("won't start by itself");
  });

  it('turns lingering on when it may', async () => {
    const exec = fakeExec({ 'loginctl show-user': { code: 0, out: 'Linger=no' } });
    const io = capture();
    expect(await installService(envFor('linux', exec), io)).toBe(0);
    expect(io.text()).toContain('lingering is on');
  });

  it('says what to do instead with no systemd user session (a container, WSL)', async () => {
    const e = envFor('linux', fakeExec({ 'systemctl --user show-environment': { code: 1, out: 'Failed to connect to bus: No medium found' } }));
    const io = capture();
    expect(await installService(e, io)).toBe(1);
    expect(io.errors()).toContain('no systemd user session');
    expect(io.errors()).toContain('beluga up --foreground');
    expect(serviceInstalled(e)).toBe(false);
  });

  it('says so when systemd refuses it', async () => {
    const io = capture();
    expect(await installService(envFor('linux', fakeExec({ 'systemctl --user enable': { code: 1, out: 'Unit is masked' } })), io)).toBe(1);
    expect(io.errors()).toContain('Unit is masked');
  });
});

describe('beluga service on a Mac', () => {
  it('loads a launchd agent, starts it with kickstart, and unloads it', async () => {
    const exec = fakeExec({ 'launchctl bootout': { code: 3, out: 'No such process' } });
    const e = envFor('darwin', exec);
    const io = capture();
    expect(await installService(e, io)).toBe(0);
    const plist = path.join(e.home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    expect(existsSync(plist)).toBe(true);
    expect(exec.calls).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`, `launchctl bootstrap gui/501 ${plist}`]);
    expect(io.text()).toContain('automatic login');
    await startService(e);
    expect(exec.calls.at(-1)).toBe(`launchctl kickstart gui/501/${LAUNCHD_LABEL}`);
    expect(await removeService(e, capture())).toBe(0);
    expect(existsSync(plist)).toBe(false);
  });

  it('says why when launchd won’t take it', async () => {
    const io = capture();
    expect(await installService(envFor('darwin', fakeExec({ 'launchctl bootstrap': { code: 5, out: 'Bootstrap failed: 5: Input/output error' } })), io)).toBe(1);
    expect(io.errors()).toContain('logged-in user');
  });
});

describe('beluga service elsewhere', () => {
  it('says it needs systemd or launchd, and removing nothing is fine', async () => {
    const io = capture();
    expect(await installService(envFor('win32', fakeExec()), io)).toBe(1);
    expect(io.errors()).toContain('systemd on Linux and launchd on a Mac');
    const none = capture();
    expect(await removeService(envFor('linux', fakeExec()), none)).toBe(0);
    expect(none.text()).toContain('No Beluga service is installed');
    const status = capture();
    serviceStatus(envFor('linux', fakeExec()), status);
    expect(status.text()).toContain('beluga service install');
  });
});
