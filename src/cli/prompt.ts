/** Questions on a terminal. Each resolves with what was typed (trimmed); Ctrl+C rejects. */
export interface Prompter {
  /** A line; Enter alone takes `fallback`. */
  ask(question: string, fallback?: string): Promise<string>;
  /** Yes or no; Enter alone takes `fallback`. */
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /** A line that isn't shown as it's typed or pasted (a token). */
  secret(question: string): Promise<string>;
}

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** Read yes or no loosely: y, yes, n, no, any case; anything else is the fallback. */
export function yesNo(answer: string, fallback: boolean): boolean {
  const a = answer.trim().toLowerCase();
  if (/^y(es)?$/.test(a)) return true;
  if (/^no?$/.test(a)) return false;
  return fallback;
}

type Input = NodeJS.ReadableStream & { readonly isTTY?: boolean; setRawMode?: (on: boolean) => unknown };

/** What was typed after the last line read (typed ahead): the next question starts with it. */
let ahead = '';

/**
 * One line from the terminal, without readline (BLG-681). In a terminal readline switches to raw
 * mode, a tcsetattr that waits for the terminal to take all pending output, and redraws the line
 * with blocking writes: a terminal that's slow to read (ssh -tt) then holds Beluga's whole event loop,
 * the daemon's link and the keys typed included. Here the terminal stays as it is (it echoes and
 * edits the line itself) and Ctrl+C is the signal it sends. Only a hidden line turns echo off (raw
 * mode, for a token's paste), and back on whatever happens.
 */
export function readLine(question: string, opts: { signal?: AbortSignal; hidden?: boolean; input?: Input; output?: NodeJS.WritableStream } = {}): Promise<string> {
  const input = opts.input ?? (process.stdin as Input);
  const output = opts.output ?? process.stderr;
  const raw = Boolean(opts.hidden && input.isTTY && input.setRawMode);
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Cancelled());
    let typed = ahead;
    ahead = '';
    const finish = (fn: () => void): void => {
      input.off('data', onData);
      opts.signal?.removeEventListener('abort', onAbort);
      process.off('SIGINT', onAbort);
      if (raw) input.setRawMode!(false);
      input.pause();
      fn();
    };
    const onAbort = (): void => finish(() => reject(new Cancelled()));
    const take = (): boolean => {
      const end = typed.search(/[\r\n]/);
      if (end < 0) return false;
      const line = typed.slice(0, end);
      ahead = typed.slice(end + 1).replace(/^\n/, '');
      if (raw) output.write('\n');
      finish(() => resolve(line.trim()));
      return true;
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of String(chunk)) {
        // Raw mode: the keys the terminal would have handled.
        if (raw && ch === '\u0003') return onAbort();
        if (raw && (ch === '\u007f' || ch === '\b')) {
          typed = typed.slice(0, -1);
          continue;
        }
        typed += ch;
      }
      take();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    // Ctrl+C is caught before the question shows: with no listener Node dies of it, saying nothing.
    process.once('SIGINT', onAbort);
    output.write(question);
    if (raw) input.setRawMode!(true);
    if (take()) return;
    input.on('data', onData);
    input.resume();
  });
}

/** The prompter on this process's terminal: questions on stderr, so piped output stays clean. */
export function terminalPrompter(input?: Input, output?: NodeJS.WritableStream): Prompter {
  const line = (question: string, hidden: boolean): Promise<string> => readLine(question, { hidden, ...(input ? { input } : {}), ...(output ? { output } : {}) });
  return {
    ask: async (q, fallback) => (await line(fallback ? `${q} [${fallback}] ` : `${q} `, false)) || (fallback ?? ''),
    confirm: async (q, fallback) => yesNo(await line(`${q} ${fallback ? '[Y/n]' : '[y/N]'} `, false), fallback),
    secret: (q) => line(`${q} `, true),
  };
}

/** Resolves when Enter is pressed on the terminal; stops listening (and never resolves) once `signal` fires. */
export function untilEnter(signal: AbortSignal, input: NodeJS.ReadableStream = process.stdin): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return;
    const onData = (chunk: Buffer | string): void => {
      if (!String(chunk).includes('\n') && !String(chunk).includes('\r')) return;
      stop();
      resolve();
    };
    const stop = (): void => {
      input.off('data', onData);
      input.pause();
      signal.removeEventListener('abort', stop);
    };
    input.on('data', onData);
    input.resume();
    signal.addEventListener('abort', stop, { once: true });
  });
}
