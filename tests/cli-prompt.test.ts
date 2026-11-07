import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Cancelled, readLine, terminalPrompter } from '../src/cli/prompt.js';

/** A terminal's keyboard: what the test types, and whether raw mode was asked for. */
function keyboard(tty = false) {
  const input = Object.assign(new PassThrough(), { isTTY: tty, modes: [] as boolean[], setRawMode(on: boolean) { this.modes.push(on); } });
  let shown = '';
  const output = new PassThrough();
  output.on('data', (d: Buffer) => (shown += d.toString()));
  return { input, output, shown: () => shown };
}

describe('reading a line without readline (BLG-681)', () => {
  it('asks, reads a whole line in the terminal’s own mode, and keeps what was typed ahead', async () => {
    const k = keyboard(true);
    const first = readLine('Pair? [y/N] ', { input: k.input, output: k.output });
    k.input.write('y\nnext');
    expect(await first).toBe('y');
    expect(k.shown()).toBe('Pair? [y/N] ');
    expect(k.input.modes).toEqual([]);
    const second = readLine('Name? ', { input: k.input, output: k.output });
    k.input.write(' box \r\n');
    expect(await second).toBe('next box');
  });

  it('a hidden line turns echo off for its paste, handles backspace and Ctrl+C, and always turns it back on', async () => {
    const k = keyboard(true);
    const token = readLine('Paste:', { hidden: true, input: k.input, output: k.output });
    k.input.write('sk-ant-x\u007fy\r');
    expect(await token).toBe('sk-ant-y');
    expect(k.input.modes).toEqual([true, false]);
    expect(k.shown()).toBe('Paste:\n');
    const stopped = readLine('Paste:', { hidden: true, input: k.input, output: k.output });
    k.input.write('sk\u0003');
    await expect(stopped).rejects.toBeInstanceOf(Cancelled);
    expect(k.input.modes).toEqual([true, false, true, false]);
  });

  it('a signal ends the question', async () => {
    const k = keyboard();
    const ctrlC = new AbortController();
    const q = readLine('Pair? ', { signal: ctrlC.signal, input: k.input, output: k.output });
    ctrlC.abort();
    await expect(q).rejects.toBeInstanceOf(Cancelled);
  });

  it('Ctrl+C is caught by the time the question shows: Node never dies of it in silence', async () => {
    const k = keyboard(true);
    const before = process.listenerCount('SIGINT');
    let caught = -1;
    const output = Object.assign(new PassThrough(), { write: () => ((caught = process.listenerCount('SIGINT')), true) });
    const q = readLine('Pair? [y/N] ', { input: k.input, output });
    expect(caught).toBe(before + 1);
    process.emit('SIGINT');
    await expect(q).rejects.toBeInstanceOf(Cancelled);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('the prompter: defaults on Enter, yes or no loosely', async () => {
    const k = keyboard();
    const p = terminalPrompter(k.input, k.output);
    const name = p.ask('Name?', 'homelab');
    k.input.write('\n');
    expect(await name).toBe('homelab');
    const keep = p.confirm('Keep it running?', true);
    k.input.write('N\n');
    expect(await keep).toBe(false);
    expect(k.shown()).toBe('Name? [homelab] Keep it running? [Y/n] ');
  });
});
