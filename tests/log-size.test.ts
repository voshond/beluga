import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keepLogSmall, trimLog } from '../src/daemon/log-size.js';

describe('daemon.log stays small while the daemon runs', () => {
  let dir: string;
  let file: string;
  let fd: number;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'beluga-log-'));
    file = path.join(dir, 'daemon.log');
    fd = openSync(file, 'a', 0o600);
  });
  afterEach(() => {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a log under the limit alone', () => {
    writeSync(fd, 'one\n');
    expect(trimLog(fd, file, 100)).toBe('kept');
    expect(readFileSync(file, 'utf8')).toBe('one\n');
  });

  it('sets the lines aside as daemon.log.1 and starts over, and the next line lands at the start', () => {
    writeSync(fd, 'old line\n'.repeat(20));
    expect(trimLog(fd, file, 100)).toBe('trimmed');
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('old line\n'.repeat(20));
    writeSync(fd, 'new line\n');
    expect(readFileSync(file, 'utf8')).toBe('new line\n');
  });

  it('never touches a file it isn’t writing', () => {
    const other = path.join(dir, 'other.log');
    writeFileSync(other, 'x'.repeat(500));
    expect(trimLog(fd, other, 100)).toBe('kept');
    expect(statSync(other).size).toBe(500);
  });

  it('says so in the log when it started over', () => {
    writeSync(fd, 'x'.repeat(500));
    const lines: string[] = [];
    const stop = keepLogSmall(fd, (l) => void lines.push(l), { file, limit: 100 });
    stop();
    expect(lines).toEqual(['log started over: the older lines are in daemon.log.1']);
    expect(statSync(file).size).toBe(0);
  });
});
