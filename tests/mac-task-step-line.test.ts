import { describe, expect, it } from 'vitest';
import { taskStepLine } from '../packages/mac/src/gateway/step-line.js';

/** A friend's task shows its steps as plain lines: only the line travels, so nothing opens. */

describe('a friend’s task step', () => {
  it('a tool line reads in words, keeps its tool for the icon and the whole line for the tooltip', () => {
    const line = 'Bash date -r 1793873141 "+daemon.json startedAt"; ps -o pid';
    expect(taskStepLine(line, 'mia')).toEqual({ words: 'Ran date -r 1793873141 "+daemon.json startedAt"; ps -o pid', tool: 'Bash', asked: false, full: line });
  });

  it('their Claude asking its owner says whom it asked, from where you sit', () => {
    const line = "Your agent (working on Kayra's request) wants to use Bash";
    expect(taskStepLine(line, 'mia')).toMatchObject({ words: 'Asked mia to allow Bash', asked: true, full: line });
    expect(taskStepLine(line).words).toBe('Asked you to allow Bash');
    expect(taskStepLine("Your agent (working on Kayra's request) wants to use mcp__beluga__send_file", 'mia').words).toBe('Asked mia to allow send_file');
    expect(taskStepLine("Your agent (working on Kayra's request) wants to change pre-commit, a file that can run commands on your Mac", 'mia').words).toBe('Asked mia to allow changing pre-commit');
  });

  it('a line in words already stays as it is, with no tool', () => {
    expect(taskStepLine('Took a screenshot of the desktop')).toEqual({ words: 'Took a screenshot of the desktop', asked: false, full: 'Took a screenshot of the desktop' });
  });
});
