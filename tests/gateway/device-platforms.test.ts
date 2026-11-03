import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pretendSystem } from '../../src/core/gateway/demo-system.js';
import { captureScreen, describeDevice, deviceInfo, linuxDisplayEnv, listWindows, parseOsRelease, parseWindowsFacts } from '../../src/core/gateway/device.js';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beluga-device-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('a friend’s screenshot and device info on Linux', () => {
  it('takes the whole screen with the first tool there is, and makes the smaller view itself', async () => {
    const sys = pretendSystem({ platform: 'linux' });
    const shot = await captureScreen(sys, tmp());
    expect(sys.ran[0]).toMatch(/^grim /);
    expect(shot.of).toBe('the main display');
    expect(shot.view).toMatch(/-view\.jpg$/);
    expect(sys.ran.some((r) => r.startsWith('sips'))).toBe(false);
  });

  it('finds the desktop when Beluga was started without one (a service, ssh, another tty)', () => {
    const look = (env: Record<string, string>, files: Record<string, string[]>) => ({ env, runtimeDir: '/run/user/1000', home: '/home/v', list: (d: string) => files[d] ?? [], exists: (f: string) => f === '/home/v/.Xauthority' });
    expect(linuxDisplayEnv(look({ DISPLAY: ':1' }, { '/tmp/.X11-unix': ['X0'] }))).toEqual({});
    expect(linuxDisplayEnv(look({}, { '/run/user/1000': ['wayland-0.lock', 'wayland-0', 'pipewire-0'], '/tmp/.X11-unix': ['X0'] }))).toEqual({ WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' });
    expect(linuxDisplayEnv(look({}, { '/run/user/1000': ['pipewire-0'], '/tmp/.X11-unix': ['X1', 'X0'] }))).toEqual({ DISPLAY: ':0', XAUTHORITY: '/home/v/.Xauthority' });
    expect(linuxDisplayEnv(look({}, {}))).toEqual({});
  });

  it("says one app's window can't be picked", async () => {
    await expect(captureScreen(pretendSystem({ platform: 'linux' }), tmp(), { app: 'Firefox' })).rejects.toThrow(/whole screen/);
    expect(await listWindows(pretendSystem({ platform: 'linux' }))).toEqual([]);
  });

  it('reads the distribution, model, battery and launcher apps', async () => {
    const info = await deviceInfo(pretendSystem({ platform: 'linux' }));
    expect(info).toMatchObject({ os: 'Ubuntu 24.04.1 LTS', model: 'ThinkPad X1 Carbon Gen 12', battery: { percent: 71, charging: true, power: 'AC Power' }, where: 'linux' });
    expect(info.apps).toEqual(['code', 'firefox', 'gnome.Nautilus']);
    expect(describeDevice(info)).toContain('3 apps in the app launcher');
    expect(parseOsRelease('ID=arch\nPRETTY_NAME=Arch Linux\n')).toBe('Arch Linux');
  });
});

describe('a friend’s screenshot and device info on Windows', () => {
  it('takes the screen, or one window by its handle, through PowerShell', async () => {
    const sys = pretendSystem({ platform: 'win32' });
    const dir = tmp();
    expect((await captureScreen(sys, dir)).of).toBe('the main display');
    expect(sys.ran.at(-1)).toContain('[BelugaShot]::Screen()');
    const win = await captureScreen(sys, dir, { app: 'chrome' });
    expect(win.of).toBe("chrome's window");
    expect(sys.ran.at(-1)).toContain('[BelugaShot]::Window(197634)');
  });

  it('reads the version, model, disk, battery and Start menu apps (never a serial number)', async () => {
    const info = await deviceInfo(pretendSystem({ platform: 'win32' }));
    expect(info).toMatchObject({ os: 'Microsoft Windows 11 Pro (build 26100)', model: 'Dell Inc. XPS 13 9340', disk: { totalGB: 512, freeGB: 200 }, battery: { percent: 64, charging: false, power: 'Battery Power', remaining: '4:10' }, where: 'windows' });
    expect(info.apps).toEqual(['Beluga', 'Visual Studio Code']);
    expect(describeDevice(info)).toContain('2 apps in the Start menu');
  });

  it('leaves out what a board says when it has no name, and copes with nothing', () => {
    expect(parseWindowsFacts(JSON.stringify({ model: 'System Product Name', maker: 'To Be Filled By O.E.M.', percent: null }))).toEqual({});
    expect(parseWindowsFacts('not json')).toEqual({});
    expect(parseWindowsFacts(JSON.stringify({ percent: 100, status: 2, minutes: 71582788 })).battery).toEqual({ power: 'AC Power', percent: 100, charging: false });
  });
});
