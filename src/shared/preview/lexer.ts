/**
 * A small TypeScript tokenizer for reading declarations (props types, component signatures), not
 * whole programs: it reads from a position on demand and stops wherever the caller stops, so the
 * JSX in a component's body (apostrophes in text, regexes) is never tokenized. Strings and
 * comments never run past their line, so a stray quote can't swallow the file. Browser-safe.
 */

export type TokenKind = 'ident' | 'string' | 'number' | 'template' | 'punct' | 'eof';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  /** Where it starts in the source. */
  readonly at: number;
  /** The /** … *\/ comment right before it, its text without the stars. */
  readonly doc?: string;
}

const PUNCT = ['=>', '...', '?.', '??', '<', '>', '{', '}', '[', ']', '(', ')', ',', ';', ':', '?', '|', '&', '=', '.', '-', '+', '*', '/', '!', '@', '#', '%', '^', '~'];

/** A JSDoc block's words: stars and leading spaces gone, @tags kept. */
export function docText(raw: string): string {
  return raw
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .trim();
}

export class Lexer {
  private pos: number;
  private peeked: Token | undefined;

  constructor(private readonly src: string, start = 0) {
    this.pos = start;
  }

  get position(): number {
    return this.peeked?.at ?? this.pos;
  }

  peek(): Token {
    this.peeked ??= this.read();
    return this.peeked;
  }

  next(): Token {
    const t = this.peek();
    this.peeked = undefined;
    return t;
  }

  /** The next token is `text` (punctuation or a word): take it. */
  eat(text: string): boolean {
    if (this.peek().text !== text || this.peek().kind === 'string') return false;
    this.next();
    return true;
  }

  /** Skip a balanced group that starts at the next token ("(", "[", "{" or "<"), taking it whole. */
  skipGroup(): void {
    const open = this.next().text;
    const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : '>';
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'eof') return;
      if (t.kind !== 'punct') continue;
      if (t.text === open) depth++;
      else if (t.text === close) depth--;
      else if (open === '<' && t.text === '=>') continue;
    }
  }

  private read(): Token {
    let doc: string | undefined;
    const src = this.src;
    for (;;) {
      while (this.pos < src.length && /\s/.test(src[this.pos]!)) this.pos++;
      if (src.startsWith('//', this.pos)) {
        const end = src.indexOf('\n', this.pos);
        this.pos = end < 0 ? src.length : end;
        continue;
      }
      if (src.startsWith('/*', this.pos)) {
        const end = src.indexOf('*/', this.pos + 2);
        const stop = end < 0 ? src.length : end + 2;
        if (src.startsWith('/**', this.pos)) doc = docText(src.slice(this.pos, stop));
        this.pos = stop;
        continue;
      }
      break;
    }
    const at = this.pos;
    const withDoc = <T extends Omit<Token, 'doc'>>(t: T): Token => (doc ? { ...t, doc } : t);
    if (at >= src.length) return { kind: 'eof', text: '', at };
    const c = src[at]!;
    if (/[A-Za-z_$]/.test(c)) {
      let end = at + 1;
      while (end < src.length && /[\w$]/.test(src[end]!)) end++;
      this.pos = end;
      return withDoc({ kind: 'ident', text: src.slice(at, end), at });
    }
    if (/\d/.test(c)) {
      const m = /^(0x[\da-f_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?n?)/i.exec(src.slice(at, at + 40));
      const text = m?.[0] ?? c;
      this.pos = at + text.length;
      return withDoc({ kind: 'number', text, at });
    }
    if (c === '"' || c === "'") {
      let end = at + 1;
      let text = '';
      while (end < src.length && src[end] !== c && src[end] !== '\n') {
        if (src[end] === '\\' && end + 1 < src.length) {
          text += src[end + 1];
          end += 2;
        } else text += src[end++];
      }
      this.pos = Math.min(src.length, end + 1);
      return withDoc({ kind: 'string', text, at });
    }
    if (c === '`') {
      const end = src.indexOf('`', at + 1);
      const stop = end < 0 ? src.length : end + 1;
      this.pos = stop;
      return withDoc({ kind: 'template', text: src.slice(at + 1, stop - 1), at });
    }
    const p = PUNCT.find((x) => src.startsWith(x, at)) ?? c;
    this.pos = at + p.length;
    return withDoc({ kind: 'punct', text: p, at });
  }
}
