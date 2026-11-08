import { Lexer, type Token } from './lexer.js';
import type { ComponentInfo, Field, Shape } from './shape.js';

/**
 * The components a file exports and what props each takes, read from the source itself: the
 * props type (an interface, a type alias, an inline object, React.FC<P>, forwardRef<R, P>, a
 * class's Component<P>), the defaults it destructures, and class-variance-authority variants
 * (shadcn's VariantProps<typeof buttonVariants>). Only this file's own declarations are followed;
 * an imported type is "unknown" and filled from the prop's name. No compiler, no AI: a small
 * parser that reads declarations and never a component's body. Browser-safe.
 */

const UNKNOWN: Shape = { kind: 'unknown' };
const NODE_TYPES = new Set(['ReactNode', 'ReactElement', 'ReactChild', 'ReactChildren', 'ReactFragment', 'ReactPortal', 'Element', 'JSXElement']);
const ARRAY_TYPES = new Set(['Array', 'ReadonlyArray', 'Set', 'ReadonlySet', 'Iterable']);
const RECORD_TYPES = new Set(['Record', 'Map', 'ReadonlyMap']);
const SAME_TYPES = new Set(['Readonly', 'NonNullable', 'Awaited', 'Promise', 'DeepReadonly']);
const FUNCTION_TYPE = /(Handler|Callback|Listener|Function|Dispatch|Fn|Action)$/;
const COMPONENT_TYPES = /^(FC|FunctionComponent|VFC|VoidFunctionComponent|ComponentType|NamedExoticComponent|MemoExoticComponent)$/;
/** How deep named types are followed (a type naming itself stops there). */
const MAX_DEPTH = 32;
/** How deep a type may nest (brackets in brackets) before it's "unknown": a pathological file reads fast. */
const MAX_NEST = 48;
/** Bigger files aren't read for components (Files' Preview, a preview's props). */
const MAX_SOURCE = 512 * 1024;

interface Decl {
  readonly kind: 'interface' | 'type';
  /** Where its body starts: the interface's "{", the type's first token after "=". */
  readonly at: number;
  /** Where its `extends` list starts (interfaces). */
  readonly extendsAt?: number;
}

/** `type X = …` and `interface X …` declarations, by name. */
function declarations(src: string): Map<string, Decl> {
  const out = new Map<string, Decl>();
  const re = /(?:^|[\n;{}])[ \t]*(?:export[ \t]+)?(?:declare[ \t]+)?(interface|type)[ \t]+([A-Za-z_$][\w$]*)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const lx = new Lexer(src, m.index + m[0].length);
    if (lx.peek().text === '<') lx.skipGroup();
    if (m[1] === 'type') {
      if (!lx.eat('=')) continue;
      out.set(m[2]!, { kind: 'type', at: lx.position });
      continue;
    }
    let extendsAt: number | undefined;
    if (lx.peek().text === 'extends') {
      lx.next();
      extendsAt = lx.position;
      while (lx.peek().kind !== 'eof' && lx.peek().text !== '{') {
        if (lx.peek().text === '<') lx.skipGroup();
        else lx.next();
      }
    }
    if (lx.peek().text !== '{') continue;
    out.set(m[2]!, { kind: 'interface', at: lx.position, ...(extendsAt !== undefined ? { extendsAt } : {}) });
  }
  return out;
}

function mergeObjects(parts: readonly Shape[]): Shape {
  const objects = parts.filter((p): p is Extract<Shape, { kind: 'object' }> => p.kind === 'object');
  if (!objects.length) return parts.find((p) => p.kind !== 'unknown') ?? parts[0] ?? UNKNOWN;
  const fields = new Map<string, Field>();
  for (const o of objects) for (const f of o.fields) fields.set(f.name, f);
  return { kind: 'object', fields: [...fields.values()] };
}

function union(options: readonly Shape[]): Shape {
  const flat = options.flatMap((o) => (o.kind === 'union' ? o.of : [o]));
  const seen = new Set<string>();
  const of = flat.filter((o) => {
    const key = JSON.stringify(o);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return of.length === 1 ? of[0]! : { kind: 'union', of };
}

/** The string literals a key type names ('a' | 'b'). */
function literalKeys(shape: Shape | undefined): string[] | undefined {
  if (!shape) return undefined;
  const of = shape.kind === 'union' ? shape.of : [shape];
  const keys = of.map((s) => (s.kind === 'literal' && typeof s.value === 'string' ? s.value : undefined));
  return keys.every((k) => k !== undefined) ? (keys as string[]) : undefined;
}

/** A `@default` in a field's doc, as a value. */
function docDefault(doc: string | undefined): unknown {
  const m = doc ? /@default(?:Value)?\s+(.+)/.exec(doc) : null;
  if (!m) return undefined;
  const raw = m[1]!.trim().replace(/^`|`$/g, '');
  try {
    return JSON.parse(raw.replace(/^'(.*)'$/, '"$1"'));
  } catch {
    return raw;
  }
}

/** A doc without its @tags, for a tooltip. */
const plainDoc = (doc: string | undefined): string | undefined => doc?.split(/\n\s*@/)[0]?.trim() || undefined;

/**
 * Another file of the project, for a type this one imports (`import type { User } from './types'`):
 * its source, and how to read the files it imports in turn. The daemon reads them (inside the
 * worktree only); the window has none, so imported types stay "unknown" there.
 */
export type SourceLoader = (spec: string) => { readonly src: string; readonly load: SourceLoader } | undefined;

/** How many files a type is followed through. */
const MAX_FILES = 4;

interface Imported {
  /** Where from ('./types', '@/lib/user'). */
  readonly from: string;
  /** Its name there. */
  readonly name: string;
}

/** What a file imports and re-exports by name, and the files it re-exports whole (`export * from`). */
function importsOf(src: string): { names: Map<string, Imported>; all: string[] } {
  const names = new Map<string, Imported>();
  const re = /\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    for (const part of m[1]!.split(',')) {
      const [name, as] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (name && /^[\w$]+$/.test(name)) names.set((as ?? name).trim(), { from: m[2]!, name });
    }
  }
  const all = [...src.matchAll(/\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
  return { names, all };
}

class TypeReader {
  private readonly decls: Map<string, Decl>;
  private readonly resolving = new Set<string>();
  private readonly cache = new Map<string, Shape>();
  private imports?: ReturnType<typeof importsOf>;

  constructor(
    private readonly src: string,
    private readonly load?: SourceLoader,
    private readonly files = 0,
  ) {
    this.decls = declarations(src);
  }

  /** A type another file declares, as this one imports it (unknown past MAX_FILES, or without a loader). */
  private foreign(name: string, depth: number): Shape | undefined {
    if (!this.load || this.files >= MAX_FILES) return undefined;
    this.imports ??= importsOf(this.src);
    const imported = this.imports.names.get(name);
    if (!imported) return undefined;
    const other = this.load(imported.from);
    if (!other) return undefined;
    return readerOf(other, this.files + 1).exported(imported.name, depth + 1);
  }

  /** A type this file exports: its own, one it re-exports, or one from a file it re-exports whole. */
  exported(name: string, depth: number): Shape {
    if (this.decls.has(name)) return this.named(name, depth);
    const again = this.foreign(name, depth);
    if (again) return again;
    if (this.load && this.files < MAX_FILES) {
      this.imports ??= importsOf(this.src);
      for (const from of this.imports.all) {
        const other = this.load(from);
        const shape = other ? readerOf(other, this.files + 1).exported(name, depth + 1) : undefined;
        if (shape && shape.kind !== 'unknown') return shape;
      }
    }
    return { kind: 'unknown', name };
  }

  /** The type that starts at `at`. */
  typeAt(at: number): Shape {
    return this.type(new Lexer(this.src, at), 0);
  }

  /** A named type of this file, followed. */
  named(name: string, depth: number): Shape {
    const decl = this.decls.get(name);
    if (!decl || depth > MAX_DEPTH || this.resolving.has(name)) return { kind: 'unknown', name };
    const kept = this.cache.get(name);
    if (kept) return kept;
    this.resolving.add(name);
    try {
      const body = decl.kind === 'type' ? this.type(new Lexer(this.src, decl.at), depth + 1) : this.object(new Lexer(this.src, decl.at), depth + 1);
      const parents: Shape[] = [];
      if (decl.extendsAt !== undefined) {
        const lx = new Lexer(this.src, decl.extendsAt);
        do parents.push(this.postfix(lx, depth + 1));
        while (lx.eat(','));
      }
      const shape = parents.length ? mergeObjects([...parents, body]) : body;
      this.cache.set(name, shape);
      return shape;
    } finally {
      this.resolving.delete(name);
    }
  }

  type(lx: Lexer, depth: number): Shape {
    if (depth > MAX_NEST) return UNKNOWN;
    lx.eat('|') || lx.eat('&');
    const options = [this.intersection(lx, depth)];
    while (lx.eat('|')) options.push(this.intersection(lx, depth));
    const shape = union(options);
    // A conditional type: either branch.
    if (lx.peek().text === 'extends' && lx.peek().kind === 'ident') {
      lx.next();
      this.type(lx, depth);
      if (!lx.eat('?')) return UNKNOWN;
      const yes = this.type(lx, depth);
      lx.eat(':');
      return union([yes, this.type(lx, depth)]);
    }
    return shape;
  }

  private intersection(lx: Lexer, depth: number): Shape {
    const parts = [this.postfix(lx, depth)];
    while (lx.eat('&')) parts.push(this.postfix(lx, depth));
    return parts.length === 1 ? parts[0]! : mergeObjects(parts);
  }

  postfix(lx: Lexer, depth: number): Shape {
    let shape = this.primary(lx, depth);
    while (lx.peek().text === '[') {
      lx.next();
      if (lx.eat(']')) {
        shape = { kind: 'array', of: shape };
        continue;
      }
      // T['key']: an indexed type.
      const key = lx.peek();
      let depthNow = 1;
      while (depthNow > 0 && lx.peek().kind !== 'eof') {
        const t = lx.next();
        if (t.text === '[') depthNow++;
        else if (t.text === ']') depthNow--;
      }
      const field = shape.kind === 'object' && key.kind === 'string' ? shape.fields.find((f) => f.name === key.text) : undefined;
      shape = field?.shape ?? UNKNOWN;
    }
    return shape;
  }

  /** Is what starts here `(…) =>` (a function type) rather than a type in parentheses? */
  private arrowAhead(at: number): boolean {
    const look = new Lexer(this.src, at);
    if (look.peek().text === '<') look.skipGroup();
    if (look.peek().text !== '(') return false;
    look.skipGroup();
    return look.peek().text === '=>';
  }

  private functionType(lx: Lexer, depth: number): Shape {
    if (lx.peek().text === '<') lx.skipGroup();
    if (lx.peek().text === '(') lx.skipGroup();
    if (lx.eat('=>')) this.type(lx, depth + 1);
    return { kind: 'function' };
  }

  private primary(lx: Lexer, depth: number): Shape {
    const t = lx.peek();
    if (t.kind === 'string') return lx.next(), { kind: 'literal', value: t.text };
    if (t.kind === 'template') return lx.next(), { kind: 'string' };
    if (t.kind === 'number') return lx.next(), { kind: 'literal', value: Number(t.text.replace(/_/g, '').replace(/n$/, '')) };
    if (t.kind === 'punct') {
      if (t.text === '{') return this.object(lx, depth);
      if (t.text === '[') return this.tuple(lx, depth);
      if (t.text === '<' || (t.text === '(' && this.arrowAhead(lx.position))) return this.functionType(lx, depth);
      if (t.text === '(') {
        lx.next();
        const inner = this.type(lx, depth + 1);
        lx.eat(')');
        return inner;
      }
      if (t.text === '-') {
        lx.next();
        const n = lx.next();
        return n.kind === 'number' ? { kind: 'literal', value: -Number(n.text) } : UNKNOWN;
      }
      return UNKNOWN;
    }
    if (t.kind !== 'ident') return UNKNOWN;
    switch (t.text) {
      case 'typeof': {
        lx.next();
        const name = this.qualified(lx);
        if (lx.peek().text === '<') lx.skipGroup();
        return { kind: 'unknown', name: `typeof ${name}` };
      }
      case 'keyof':
        lx.next();
        this.postfix(lx, depth);
        return { kind: 'string' };
      case 'readonly':
        lx.next();
        return this.postfix(lx, depth);
      case 'new':
      case 'abstract':
        lx.next();
        if (lx.peek().text === 'new') lx.next();
        return this.functionType(lx, depth);
      case 'infer':
      case 'unique':
        lx.next();
        lx.next();
        return UNKNOWN;
      case 'true':
      case 'false':
        lx.next();
        return { kind: 'literal', value: t.text === 'true' };
      case 'null':
      case 'undefined':
      case 'void':
        lx.next();
        return { kind: 'literal', value: null };
    }
    const name = this.qualified(lx);
    const args: Shape[] = [];
    if (lx.peek().text === '<') {
      lx.next();
      if (lx.peek().text !== '>') {
        args.push(this.type(lx, depth + 1));
        while (lx.eat(',')) args.push(this.type(lx, depth + 1));
      }
      lx.eat('>');
    }
    return this.reference(name, args, depth);
  }

  private qualified(lx: Lexer): string {
    let name = lx.next().text;
    while (lx.peek().text === '.') {
      lx.next();
      name += `.${lx.next().text}`;
    }
    return name;
  }

  private reference(name: string, args: readonly Shape[], depth: number): Shape {
    const last = name.split('.').pop() ?? name;
    const first = args[0];
    if (last === 'string' || last === 'String') return { kind: 'string' };
    if (last === 'number' || last === 'Number' || last === 'bigint' || last === 'BigInt') return { kind: 'number' };
    if (last === 'boolean' || last === 'Boolean') return { kind: 'boolean' };
    if (last === 'Date') return { kind: 'date' };
    if (NODE_TYPES.has(last)) return { kind: 'node' };
    if (ARRAY_TYPES.has(last)) return { kind: 'array', of: first ?? UNKNOWN };
    if (RECORD_TYPES.has(last)) {
      const keys = literalKeys(first);
      const value = args[1] ?? UNKNOWN;
      return keys ? { kind: 'object', fields: keys.map((k) => ({ name: k, optional: false, shape: value })) } : { kind: 'record', of: value };
    }
    if (SAME_TYPES.has(last)) return first ?? UNKNOWN;
    if (last === 'Partial' || last === 'Required') {
      if (first?.kind !== 'object') return first ?? UNKNOWN;
      return { kind: 'object', fields: first.fields.map((f) => ({ ...f, optional: last === 'Partial' })) };
    }
    if (last === 'Pick' || last === 'Omit') {
      const keys = new Set(literalKeys(args[1]) ?? []);
      if (first?.kind !== 'object') return first ?? UNKNOWN;
      return { kind: 'object', fields: first.fields.filter((f) => keys.has(f.name) === (last === 'Pick')) };
    }
    if (last === 'Exclude' || last === 'Extract') {
      const drop = new Set((args[1]?.kind === 'union' ? args[1].of : args[1] ? [args[1]] : []).map((s) => JSON.stringify(s)));
      const of = first?.kind === 'union' ? first.of : first ? [first] : [];
      return union(of.filter((s) => drop.has(JSON.stringify(s)) === (last === 'Extract')));
    }
    if (last === 'PropsWithChildren') return mergeObjects([first ?? { kind: 'object', fields: [] }, { kind: 'object', fields: [{ name: 'children', optional: true, shape: { kind: 'node' } }] }]);
    if (last === 'VariantProps' && first?.kind === 'unknown' && first.name?.startsWith('typeof ')) return variantsOf(this.src, first.name.slice(7));
    if (last === 'Function' || last === 'VoidFunction' || FUNCTION_TYPE.test(last)) return { kind: 'function' };
    if (this.decls.has(name)) return this.named(name, depth + 1);
    return this.foreign(name, depth) ?? { kind: 'unknown', name };
  }

  object(lx: Lexer, depth: number): Shape {
    if (!lx.eat('{')) return UNKNOWN;
    const fields: Field[] = [];
    let indexed: Shape | undefined;
    while (lx.peek().kind !== 'eof' && lx.peek().text !== '}') {
      const before = lx.position;
      if (lx.eat(';') || lx.eat(',')) continue;
      let head: Token = lx.next();
      const doc = head.doc;
      // Modifiers (`readonly x`, a mapped type's `-readonly [K in …]`), never a field named "readonly".
      while ((head.text === 'readonly' || head.text === '+' || head.text === '-') && head.kind !== 'string') {
        const after = lx.peek();
        if (!(after.kind === 'ident' || after.kind === 'string' || after.text === '[')) break;
        head = lx.next();
      }
      if (head.text === '[' && head.kind === 'punct') {
        // [key: string]: T, or a mapped type [K in Keys]: T.
        let d = 1;
        while (d > 0 && lx.peek().kind !== 'eof') {
          const t = lx.next();
          if (t.text === '[') d++;
          else if (t.text === ']') d--;
        }
        lx.eat('-');
        lx.eat('+');
        lx.eat('?');
        if (lx.eat(':')) indexed = this.type(lx, depth + 1);
        continue;
      }
      if (head.kind !== 'ident' && head.kind !== 'string' && head.kind !== 'number') {
        if (lx.position === before) lx.next();
        continue;
      }
      const optional = lx.eat('?');
      let shape: Shape;
      if (lx.peek().text === '(' || lx.peek().text === '<') {
        // A method: name(args): T.
        if (lx.peek().text === '<') lx.skipGroup();
        lx.skipGroup();
        if (lx.eat(':')) this.type(lx, depth + 1);
        shape = { kind: 'function' };
      } else shape = lx.eat(':') ? this.type(lx, depth + 1) : UNKNOWN;
      const fallback = docDefault(doc);
      const tip = plainDoc(doc);
      fields.push({ name: head.text, optional, shape, ...(tip ? { doc: tip } : {}), ...(fallback !== undefined ? { fallback } : {}) });
    }
    lx.eat('}');
    if (!fields.length && indexed) return { kind: 'record', of: indexed };
    return { kind: 'object', fields };
  }

  private tuple(lx: Lexer, depth: number): Shape {
    lx.eat('[');
    const of: Shape[] = [];
    while (lx.peek().kind !== 'eof' && lx.peek().text !== ']') {
      const before = lx.position;
      if (lx.eat(',')) continue;
      const rest = lx.eat('...');
      // A named member: `label: T` or `label?: T`.
      const look = new Lexer(this.src, lx.position);
      const a = look.next();
      const b = look.next();
      if (a.kind === 'ident' && (b.text === ':' || (b.text === '?' && look.next().text === ':'))) {
        lx.next();
        lx.eat('?');
        lx.eat(':');
      }
      const item = this.type(lx, depth + 1);
      lx.eat('?');
      of.push(rest && item.kind === 'array' ? item.of : item);
      if (lx.position === before) lx.next();
    }
    lx.eat(']');
    return { kind: 'tuple', of };
  }
}

/** One reader per file a loader read (the loader gives the same answer for the same file): each parsed once. */
const readers = new WeakMap<object, TypeReader>();
function readerOf(file: { readonly src: string; readonly load: SourceLoader }, files: number): TypeReader {
  let reader = readers.get(file);
  if (!reader) readers.set(file, (reader = new TypeReader(file.src, file.load, files)));
  return reader;
}

/**
 * class-variance-authority's variants (`const buttonVariants = cva('…', { variants: { size: { sm,
 * lg } }, defaultVariants: { size: 'sm' } })`): one choice prop per variant, its default kept.
 */
function variantsOf(src: string, name: string): Shape {
  const at = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\s*=\\s*(?:\\w+\\.)?(?:cva|tv)\\s*\\(`).exec(src);
  if (!at) return UNKNOWN;
  const keysOf = (lx: Lexer): Map<string, number> => {
    // The keys of the object at the lexer, and where each one's value starts.
    const out = new Map<string, number>();
    if (!lx.eat('{')) return out;
    while (lx.peek().kind !== 'eof' && lx.peek().text !== '}') {
      const key = lx.next();
      if (key.kind !== 'ident' && key.kind !== 'string' && key.kind !== 'number') continue;
      if (!lx.eat(':')) continue;
      out.set(key.text, lx.position);
      skipValue(lx);
      lx.eat(',');
    }
    return out;
  };
  const body = src.slice(at.index + at[0].length);
  const variants = /\bvariants\s*:\s*\{/.exec(body);
  if (!variants) return UNKNOWN;
  const base = at.index + at[0].length;
  const groups = keysOf(new Lexer(src, base + variants.index + variants[0].length - 1));
  const defaults = /\bdefaultVariants\s*:\s*\{/.exec(body);
  const fallbacks = new Map<string, unknown>();
  if (defaults) {
    const lx = new Lexer(src, base + defaults.index + defaults[0].length - 1);
    for (const [key, valueAt] of keysOf(lx)) {
      const v = new Lexer(src, valueAt).next();
      fallbacks.set(key, v.kind === 'string' ? v.text : v.kind === 'number' ? Number(v.text) : v.text === 'true' ? true : v.text === 'false' ? false : undefined);
    }
  }
  const fields: Field[] = [...groups].map(([key, valueAt]) => {
    const options = [...keysOf(new Lexer(src, valueAt)).keys()];
    const bools = options.length && options.every((o) => o === 'true' || o === 'false');
    const shape: Shape = bools ? { kind: 'boolean' } : union(options.map((o) => ({ kind: 'literal', value: o })));
    const fallback = fallbacks.get(key);
    return { name: key, optional: true, shape, ...(fallback !== undefined ? { fallback } : {}) };
  });
  return { kind: 'object', fields };
}

/** Skip one expression (a value in an object or a default), up to the "," or closing bracket that ends it. */
function skipValue(lx: Lexer): void {
  let depth = 0;
  while (lx.peek().kind !== 'eof') {
    const t = lx.peek();
    if (t.kind === 'punct') {
      if (depth === 0 && (t.text === ',' || t.text === '}' || t.text === ')' || t.text === ']')) return;
      if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
      else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
    }
    lx.next();
  }
}

/** A literal default (`'md'`, `3`, `true`, `[]`); anything else is left to the component. */
function literalValue(lx: Lexer): unknown {
  const t = lx.peek();
  const at = lx.position;
  let value: unknown;
  if (t.kind === 'string' || t.kind === 'template') value = t.text;
  else if (t.kind === 'number') value = Number(t.text.replace(/_/g, ''));
  else if (t.text === 'true' || t.text === 'false') value = t.text === 'true';
  else if (t.text === 'null') value = null;
  else if (t.text === '-') {
    lx.next();
    const n = lx.peek();
    value = n.kind === 'number' ? -Number(n.text) : undefined;
  } else if (t.text === '[' || t.text === '{') {
    lx.next();
    const empty = lx.peek().text === (t.text === '[' ? ']' : '}');
    value = empty ? (t.text === '[' ? [] : {}) : undefined;
  }
  skipValue(lx);
  // An expression that only started like a literal ('a' + b) isn't one.
  return lx.position > at ? value : undefined;
}

interface Params {
  /** Names destructured from the props, with literal defaults. */
  readonly names: ReadonlyArray<{ readonly name: string; readonly fallback?: unknown }>;
  readonly shape?: Shape;
  /** It passes the rest on (`...props`): HTML attributes, children among them. */
  readonly rest?: boolean;
}

/** A component's first parameter, starting at its "(" (or generics, or a bare `props =>`). */
function readParams(reader: TypeReader, src: string, at: number): Params {
  const lx = new Lexer(src, at);
  if (lx.peek().text === '<') lx.skipGroup();
  if (lx.peek().kind === 'ident') return { names: [] };
  if (!lx.eat('(') || lx.peek().text === ')') return { names: [] };
  const names: Array<{ name: string; fallback?: unknown }> = [];
  let rest = false;
  if (lx.peek().text === '{') {
    lx.next();
    while (lx.peek().kind !== 'eof' && lx.peek().text !== '}') {
      const before = lx.position;
      if (lx.eat(',')) continue;
      if (lx.eat('...')) {
        lx.next();
        rest = true;
        continue;
      }
      const key = lx.next();
      if (lx.eat(':')) {
        if (lx.peek().text === '{' || lx.peek().text === '[') lx.skipGroup();
        else lx.next();
      }
      const fallback = lx.eat('=') ? literalValue(lx) : undefined;
      if (key.kind === 'ident' || key.kind === 'string') names.push({ name: key.text, ...(fallback !== undefined ? { fallback } : {}) });
      if (lx.position === before) lx.next();
    }
    lx.eat('}');
  } else if (lx.peek().kind === 'ident') lx.next();
  else return { names };
  lx.eat('?');
  const more = rest ? { rest } : {};
  return lx.eat(':') ? { names, shape: reader.typeAt(lx.position), ...more } : { names, ...more };
}

/** The fields a component's props have, from its type and what it destructures. */
function fieldsOf(params: Params): Field[] {
  const typed = params.shape?.kind === 'object' ? params.shape.fields : [];
  const defaults = new Map(params.names.map((n) => [n.name, n.fallback]));
  const fields = typed.map((f) => {
    const fallback = defaults.get(f.name);
    return fallback !== undefined ? { ...f, fallback } : f;
  });
  const known = new Set(fields.map((f) => f.name));
  // Destructured but not in the type (it comes from an imported or HTML type), or no type at all (JavaScript).
  for (const n of params.names) {
    if (known.has(n.name)) continue;
    known.add(n.name);
    fields.push({ name: n.name, optional: true, shape: n.name === 'children' ? { kind: 'node' } : { kind: 'unknown' }, ...(n.fallback !== undefined ? { fallback: n.fallback } : {}) });
  }
  // Passing the rest on to an element (a Button over <button>): it draws its children.
  if (params.rest && !known.has('children')) fields.push({ name: 'children', optional: true, shape: { kind: 'node' } });
  return fields;
}

interface Candidate {
  readonly name: string;
  /** Where it's declared: components are listed in the file's order. */
  readonly at: number;
  readonly exported: boolean;
  readonly isDefault: boolean;
  readonly params: () => Params;
}

/** What follows `const X =`: where a component's parameters start, and props named in its generics. */
function arrowParams(reader: TypeReader, src: string, at: number): (() => Params) | undefined {
  const lx = new Lexer(src, at);
  let generic: Shape | undefined;
  // React.memo(…), forwardRef<Ref, Props>(…), observer(…): the function inside.
  for (let wraps = 0; wraps < 3; wraps++) {
    const t = lx.peek();
    if (t.kind !== 'ident' || t.text === 'function' || t.text === 'async') break;
    const look = new Lexer(src, lx.position);
    let name = look.next().text;
    while (look.peek().text === '.') {
      look.next();
      name = look.next().text;
    }
    if (!/^(memo|forwardRef|observer|withRouter)$/.test(name)) return undefined;
    while (lx.position < look.position) lx.next();
    if (lx.peek().text === '<') {
      const typeArgsAt = lx.position;
      const args = new Lexer(src, typeArgsAt);
      args.next();
      const first = reader.type(args, 0);
      const second = args.eat(',') ? reader.type(args, 0) : undefined;
      generic = name === 'forwardRef' ? second : first;
      lx.skipGroup();
    }
    if (!lx.eat('(')) return undefined;
  }
  lx.eat('async');
  if (lx.eat('function')) {
    if (lx.peek().kind === 'ident') lx.next();
  }
  const t = lx.peek();
  if (t.text !== '(' && t.text !== '<' && t.kind !== 'ident') return undefined;
  if (t.kind === 'ident') {
    // `props => …` only counts when an arrow follows.
    const look = new Lexer(src, lx.position);
    look.next();
    if (look.peek().text !== '=>') return undefined;
  }
  const start = lx.position;
  return () => {
    const params = readParams(reader, src, start);
    return generic && !params.shape ? { ...params, shape: generic } : params;
  };
}

/** Exported names: `export { A, B as C }`, `export default X`, `export default memo(X)`. */
function exportsOf(src: string): { names: Map<string, string>; defaultName?: string } {
  const names = new Map<string, string>();
  let defaultName: string | undefined;
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(',')) {
      const [local, as] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if (!local) continue;
      if (as === 'default') defaultName = local;
      else names.set(local, as ?? local);
    }
  }
  const plain = /\bexport\s+default\s+(?:(?:React\.)?(?:memo|forwardRef|observer)\s*\(\s*)?([A-Z][\w$]*)\s*\)?\s*;?\s*$/m.exec(src);
  if (plain && !/^(function|class|async)$/.test(plain[1]!)) defaultName = plain[1];
  return { names, ...(defaultName ? { defaultName } : {}) };
}

/** Every component the file declares, exported or not. */
function candidates(reader: TypeReader, src: string): Candidate[] {
  const byName = new Map<string, Candidate>();
  // One per name: `export const Memo = memo(function Memo…)` is the exported one, not the function inside.
  const add = (c: Candidate): void => {
    const was = byName.get(c.name);
    if (!was || (!was.exported && c.exported)) byName.set(c.name, c);
  };
  for (const m of src.matchAll(/\bexport\s+default\s+(?:async\s+)?function\s*([A-Z][\w$]*)?\s*(?=[<(])/g)) {
    const at = m.index + m[0].length;
    add({ name: m[1] ?? 'default', at: m.index, exported: true, isDefault: true, params: () => readParams(reader, src, at) });
  }
  for (const m of src.matchAll(/(^|[^\w$.])(export\s+)?(?:async\s+)?function\s+([A-Z][\w$]*)\s*(?=[<(])/g)) {
    const at = m.index + m[0].length;
    add({ name: m[3]!, at: m.index, exported: Boolean(m[2]), isDefault: false, params: () => readParams(reader, src, at) });
  }
  for (const m of src.matchAll(/(^|[^\w$.])(export\s+)?(?:const|let|var)\s+([A-Z][\w$]*)\s*(:\s*)?/g)) {
    const name = m[3]!;
    const lx = new Lexer(src, m.index + m[0].length);
    let annotated: Shape | undefined;
    if (m[4]) {
      // const X: React.FC<Props> = …
      let typeName = lx.next().text;
      while (lx.peek().text === '.') {
        lx.next();
        typeName = lx.next().text;
      }
      if (lx.peek().text === '<') {
        lx.next();
        const first = reader.type(lx, 0);
        if (COMPONENT_TYPES.test(typeName)) annotated = first;
        while (lx.peek().kind !== 'eof' && lx.peek().text !== '>') lx.next();
        lx.eat('>');
      }
    }
    if (!lx.eat('=')) continue;
    const params = arrowParams(reader, src, lx.position);
    if (!params) continue;
    add({
      name,
      at: m.index,
      exported: Boolean(m[2]),
      isDefault: false,
      params: () => {
        const read = params();
        return annotated && !read.shape ? { ...read, shape: annotated } : read;
      },
    });
  }
  for (const m of src.matchAll(/(^|[^\w$.])(export\s+)?(default\s+)?class\s+([A-Z][\w$]*)\s+extends\s+(?:React\.)?(?:Pure)?Component\s*(?=<)/g)) {
    const at = m.index + m[0].length;
    add({
      name: m[4]!,
      at: m.index,
      exported: Boolean(m[2]),
      isDefault: Boolean(m[3]),
      params: () => {
        const lx = new Lexer(src, at);
        lx.next();
        return { names: [], shape: reader.type(lx, 0) };
      },
    });
  }
  return [...byName.values()].sort((a, b) => a.at - b.at);
}

/** The components a file exports, each with its props (the default export first). */
export function findComponents(src: string, load?: SourceLoader): ComponentInfo[] {
  if (src.length > MAX_SOURCE) return [];
  const reader = new TypeReader(src, load);
  const { names, defaultName } = exportsOf(src);
  const found: ComponentInfo[] = candidates(reader, src).flatMap((c) => {
    const isDefault = c.isDefault || c.name === defaultName;
    const exported = c.exported || isDefault || names.has(c.name);
    return exported ? [{ name: names.get(c.name) ?? c.name, isDefault, props: fieldsOf(c.params()) }] : [];
  });
  return [...found.filter((c) => c.isDefault), ...found.filter((c) => !c.isDefault)];
}

/** The component a preview draws: the one asked for, else the default export, else the first. */
export function pickComponent(components: readonly ComponentInfo[], wanted?: string): ComponentInfo | undefined {
  if (wanted) return components.find((c) => c.name === wanted || (wanted === 'default' && c.isDefault));
  return components[0];
}

/** A file that looks like it holds React components (worth a Preview view in Files). */
export function looksLikeComponents(path: string, src: string): boolean {
  if (!/\.(tsx|jsx)$/i.test(path)) return false;
  if (/\.(test|spec|stories|story)\.[jt]sx$/i.test(path)) return false;
  return findComponents(src).length > 0;
}
