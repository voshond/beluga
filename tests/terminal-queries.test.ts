import xtermHeadless from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import { PtyProcess } from '../src/terminal/pty-host.js';
import { withoutQueries } from '../src/terminal/queries.js';
import { waitFor } from './helpers.js';

const { Terminal } = xtermHeadless;

const ESC = '\x1b';
const ST = `${ESC}\\`;
const QUERIES = [`${ESC}[6n`, `${ESC}[?6n`, `${ESC}[5n`, `${ESC}[c`, `${ESC}[>c`, `${ESC}[>0q`, `${ESC}[?2004$p`, `${ESC}[14t`, `${ESC}[?u`, `${ESC}]11;?\x07`, `${ESC}]10;?${ST}`, `${ESC}]4;1;?\x07`, `${ESC}P$qm${ST}`];
const DRAWING = `${ESC}]0;title?\x07${ESC}[1;31mhi${ESC}[0m ${ESC}[?2004h${ESC}[2J${ESC}[H${ESC}[22;0t${ESC}[2 q${ESC}]11;#000000\x07$ `;

const cleanup: Array<() => unknown> = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});

const answers = async (output: string): Promise<string> => {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  let typed = '';
  term.onData((d) => (typed += d));
  await new Promise<void>((done) => term.write(output, done));
  term.dispose();
  return typed;
};

describe('withoutQueries', () => {
  it('takes out every query and leaves what draws alone', () => {
    expect(withoutQueries(`${DRAWING}${QUERIES.join('a')}b`)).toBe(`${DRAWING}${'a'.repeat(QUERIES.length - 1)}b`);
  });

  it('leaves a replayed screen nothing to answer', async () => {
    const output = `${DRAWING}${QUERIES.join('')}`;
    expect(await answers(output)).not.toBe('');
    expect(await answers(withoutQueries(output))).toBe('');
  });

  it('keeps the queries out of what a screen attaching later is sent', async () => {
    const pty = new PtyProcess({ id: 't', cwd: process.cwd(), shell: '/bin/sh', args: ['-c', `printf 'ready\\033]11;?\\007\\033[6n'; sleep 5`], cols: 80, rows: 24 });
    cleanup.push(() => pty.dispose());
    await waitFor(() => pty.backlog().includes('ready'));
    expect(pty.replay()).toBe('ready');
  });
});

describe('withoutQueries, sequence by sequence', () => {
  it('drops the background colour and cursor position queries a shell would get answers to', () => {
    const out = 'Press Enter when it is done\r\n\x1b]11;?\x1b\\\x1b[6n$ ';
    expect(withoutQueries(out)).toBe('Press Enter when it is done\r\n$ ');
  });

  it('drops colour queries ended by BEL, palette and clipboard queries', () => {
    expect(withoutQueries('a\x1b]10;?\x07b\x1b]4;1;?\x07c\x1b]52;c;?\x07d')).toBe('abcd');
  });

  it('drops device attributes, status, mode, version, keyboard and window reports', () => {
    const q = ['\x1b[c', '\x1b[0c', '\x1b[>c', '\x1b[=c', '\x1b[5n', '\x1b[?6n', '\x1b[?2004$p', '\x1b[>0q', '\x1b[?u', '\x1b[14t', '\x1b[18t', '\x1bP$qm\x1b\\', '\x1bP+q544e\x1b\\'];
    expect(withoutQueries(`x${q.join('')}y`)).toBe('xy');
  });

  it('keeps what draws: colours, cursor moves, titles, cursor shape, title push and pop', () => {
    const draws = '\x1b[31mred\x1b[0m\x1b[2J\x1b[H\x1b]0;title\x07\x1b]11;#000000\x07\x1b[2 q\x1b[22;0t\x1b[23;0t\x1b[?2004h';
    expect(withoutQueries(draws)).toBe(draws);
  });

  it('leaves plain text alone', () => {
    expect(withoutQueries('hello world')).toBe('hello world');
  });
});
