import { describe, expect, it } from 'vitest';
import { openCommand, revealCommand, spawnOptions } from '../src/core/os-open.js';

describe('opening things with the system', () => {
  it('opens with `open` on the Mac and xdg-open on Linux, as given', () => {
    expect(openCommand('/Users/me/proj', 'darwin')).toEqual({ cmd: 'open', args: ['/Users/me/proj'] });
    expect(openCommand('/home/me/proj', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/home/me/proj'] });
  });

  it('gives Explorer back slashes only: a "/" is a switch to it', () => {
    expect(openCommand('C:\\Users\\me\\.beluga/logs', 'win32').args).toEqual(['C:\\Users\\me\\.beluga\\logs']);
    expect(openCommand('C:\\proj/.beluga/scratch/shot.png', 'win32').args).toEqual(['C:\\proj\\.beluga\\scratch\\shot.png']);
    expect(openCommand('C:/proj', 'win32').args).toEqual(['C:\\proj']);
  });

  it('leaves URLs as they are on Windows', () => {
    expect(openCommand('https://github.com/o/r/pull/1', 'win32').args).toEqual(['https://github.com/o/r/pull/1']);
  });

  it('shows a file selected in Finder and in Explorer', () => {
    expect(revealCommand('/Users/me/a b.png', 'darwin')).toEqual({ cmd: 'open', args: ['-R', '/Users/me/a b.png'] });
    expect(revealCommand('C:\\Users\\me\\my proj/.beluga/scratch/a.png', 'win32')).toEqual({
      cmd: 'explorer',
      args: ['/select,"C:\\Users\\me\\my proj\\.beluga\\scratch\\a.png"'],
      verbatim: true,
    });
  });

  it('never starts Explorer with its window hidden: windowsHide would keep the folder window invisible', () => {
    expect(spawnOptions(openCommand('C:\\proj', 'win32'))).toEqual({ stdio: 'ignore', detached: true, windowsHide: false });
    expect(spawnOptions(revealCommand('C:\\proj\\a.png', 'win32'))).toEqual({ stdio: 'ignore', detached: true, windowsHide: false, windowsVerbatimArguments: true });
    expect(spawnOptions(openCommand('/Users/me/proj', 'darwin')).windowsHide).toBe(false);
  });

  it('opens the folder a file is in on Linux', () => {
    expect(revealCommand('/home/me/proj/.beluga/scratch/a.png', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/home/me/proj/.beluga/scratch'] });
  });
});
