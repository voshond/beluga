/** Where a command says things: the terminal, or a test's buffer. */
export interface Io {
  /** What the command was asked for. */
  out(text: string): void;
  /** Problems and progress, kept out of piped output. */
  err(text: string): void;
}

export const stdio: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/** An exit code: 0 done, 1 it couldn't be done, 2 it was typed wrong, 130 stopped with Ctrl+C. */
export type Exit = 0 | 1 | 2 | 130;

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** "3 minutes", "2 hours", "5 days": how long ago, in plain words. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (s < 60) return unit(s, 'second');
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86_400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86_400), 'day');
}
