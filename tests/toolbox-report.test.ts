import { describe, expect, it } from 'vitest';
import { parseToolReport, toolOutcome } from '../src/workspaces/toolbox.js';

describe('parseToolReport', () => {
  it('reads a status and its message', () => {
    expect(parseToolReport('::beluga status=success Deployed to arch')).toEqual({ status: 'success', message: 'Deployed to arch' });
    expect(parseToolReport('::beluga status=warn m1arch asleep')).toEqual({ status: 'warn', message: 'm1arch asleep' });
    expect(parseToolReport('::beluga status=fail')).toEqual({ status: 'fail', message: '' });
  });

  it('ignores colors, a carriage return and surrounding space', () => {
    expect(parseToolReport('\x1b[32m::beluga status=success done\x1b[0m\r')).toEqual({ status: 'success', message: 'done' });
  });

  it('skips lines that are not a marker', () => {
    expect(parseToolReport('arch: deploying')).toBeUndefined();
    expect(parseToolReport('echo ::beluga status=success nope')).toBeUndefined();
    expect(parseToolReport('::beluga status=great job')).toBeUndefined();
  });

  it('caps a long message', () => {
    expect(parseToolReport(`::beluga status=fail ${'x'.repeat(500)}`)?.message).toHaveLength(200);
  });
});

describe('toolOutcome', () => {
  it('succeeds on exit 0 with no report', () => {
    expect(toolOutcome(0, undefined)).toEqual({ status: 'success', message: '' });
  });

  it('takes the report on exit 0', () => {
    expect(toolOutcome(0, { status: 'warn', message: 'half' })).toEqual({ status: 'warn', message: 'half' });
  });

  it('fails on a non-zero exit, keeping a fail message only', () => {
    expect(toolOutcome(2, undefined)).toEqual({ status: 'fail', message: 'exit 2' });
    expect(toolOutcome(1, { status: 'success', message: 'lied' })).toEqual({ status: 'fail', message: 'exit 1' });
    expect(toolOutcome(1, { status: 'fail', message: 'build broke' })).toEqual({ status: 'fail', message: 'build broke' });
    expect(toolOutcome(null, undefined)).toEqual({ status: 'fail', message: 'exit ?' });
  });
});
