import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Loader, Plugin } from 'esbuild';

/**
 * Vite's own additions to `import.meta`, which a Vite project's code uses and esbuild doesn't know:
 * `import.meta.glob` (expanded here into the imports it stands for) and `import.meta.env` (Vite's
 * built-in values; a project's VITE_ variables are left out, as they live in .env files).
 */

export const VITE_ENV = { MODE: 'development', DEV: true, PROD: false, SSR: false, BASE_URL: '/' } as const;

const SOURCE = /\.(tsx?|jsx?|mjs|mts)$/;
const GLOB_CALL = /import\.meta\.glob\s*(<[^>(]*>)?\s*\(/g;
const MAX_FILES = 2000;

const LOADERS: Readonly<Record<string, Loader>> = { '.ts': 'ts', '.mts': 'ts', '.tsx': 'tsx', '.jsx': 'jsx', '.js': 'jsx', '.mjs': 'js' };

const escape = (s: string): string => s.replace(/[.+^$()|[\]\\]/g, '\\$&');

export function globRegex(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end < 0) {
        out += '\\{';
        continue;
      }
      out += `(?:${pattern
        .slice(i + 1, end)
        .split(',')
        .map((part) => globRegex(part).source.slice(1, -1))
        .join('|')})`;
      i = end;
    } else out += escape(c);
  }
  return new RegExp(`^${out}$`);
}

const staticDir = (pattern: string): string => {
  const parts = pattern.split('/');
  const fixed: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?{[]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join('/');
};

const walk = (dir: string, found: string[]): void => {
  if (found.length >= MAX_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, found);
    else if (e.isFile()) found.push(full);
    if (found.length >= MAX_FILES) return;
  }
};

type GlobOptions = { readonly eager: boolean; readonly named?: string };

export function expandGlob(root: string, importer: string, patterns: readonly string[]): string[] {
  const dir = path.dirname(importer);
  const keyOf = (file: string, absolute: boolean): string => {
    if (absolute) return `/${path.relative(root, file).split(path.sep).join('/')}`;
    const rel = path.relative(dir, file).split(path.sep).join('/');
    return rel.startsWith('.') ? rel : `./${rel}`;
  };
  const keys = new Set<string>();
  for (const raw of patterns.filter((p) => !p.startsWith('!'))) {
    const absolute = raw.startsWith('/');
    const base = absolute ? root : dir;
    const pattern = absolute ? raw.slice(1) : raw;
    const from = path.resolve(base, staticDir(pattern));
    const inside = path.relative(root, from);
    if (inside.startsWith('..') || path.isAbsolute(inside)) continue;
    const files: string[] = [];
    walk(from, files);
    const wanted = globRegex(path.posix.normalize(path.relative(base, path.resolve(base, pattern)).split(path.sep).join('/')));
    for (const file of files) if (wanted.test(path.relative(base, file).split(path.sep).join('/'))) keys.add(keyOf(file, absolute));
  }
  const excluded = patterns.filter((p) => p.startsWith('!')).map((p) => globRegex(p.slice(1)));
  return [...keys].filter((k) => !excluded.some((re) => re.test(k))).sort();
}

const callEnd = (src: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      const close = src.indexOf(c, i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const optionsOf = (text: string): GlobOptions => {
  const named = /\bimport\s*:\s*['"]([A-Za-z_$][\w$]*)['"]/.exec(text)?.[1];
  return { eager: /\beager\s*:\s*true\b/.test(text), ...(named ? { named } : {}) };
};

export function rewriteGlobs(src: string, root: string, importer: string): string | undefined {
  if (!src.includes('import.meta.glob')) return undefined;
  const imports: string[] = [];
  let out = '';
  let last = 0;
  let n = 0;
  for (const m of src.matchAll(GLOB_CALL)) {
    const open = m.index + m[0].length - 1;
    const end = callEnd(src, open);
    if (end < 0) continue;
    const args = src.slice(open + 1, end);
    const firstArg = /^\s*(\[[^\]]*\]|(['"`])[^'"`]*\2)/.exec(args)?.[1] ?? '';
    const patterns = [...firstArg.matchAll(/(['"`])([^'"`]*)\1/g)].map((p) => p[2]!);
    const options = optionsOf(args.slice(firstArg.length));
    const entries = expandGlob(root, importer, patterns).map((key, k) => {
      const spec = JSON.stringify(key);
      if (!options.eager) return `${spec}: () => import(${spec})${options.named ? `.then((m) => m[${JSON.stringify(options.named)}])` : ''}`;
      const local = `__belugaGlob${n}_${k}`;
      imports.push(options.named === 'default' ? `import ${local} from ${spec};` : options.named ? `import { ${options.named} as ${local} } from ${spec};` : `import * as ${local} from ${spec};`);
      return `${spec}: ${local}`;
    });
    out += `${src.slice(last, m.index)}({${entries.join(', ')}})`;
    last = end + 1;
    n++;
  }
  if (!n) return undefined;
  return `${imports.join('\n')}\n${out}${src.slice(last)}`;
}

export function vitePlugin(root: string): Plugin {
  return {
    name: 'beluga-vite',
    setup(build) {
      build.onLoad({ filter: SOURCE }, (args) => {
        if (args.namespace !== 'file' || args.path.includes(`${path.sep}node_modules${path.sep}`)) return undefined;
        let src: string;
        try {
          src = readFileSync(args.path, 'utf8');
        } catch {
          return undefined;
        }
        const contents = rewriteGlobs(src, root, args.path);
        if (contents === undefined) return undefined;
        return { contents, loader: LOADERS[path.extname(args.path)] ?? 'tsx', resolveDir: path.dirname(args.path) };
      });
    },
  };
}
