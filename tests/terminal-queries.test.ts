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
    expect(pty.backlog()).toBe('ready');
  });
});
