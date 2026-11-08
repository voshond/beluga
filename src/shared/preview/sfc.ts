import { type SourceLoader, findComponents } from './props.js';
import type { ComponentInfo } from './shape.js';

/**
 * The props of a Vue or Svelte single-file component, read with the same reader as React's
 * (props.ts): its <script> is read as TypeScript, and how it declares props becomes a component
 * signature that reader knows.
 *
 * - Vue: `defineProps<Props>()` (or an inline type), `withDefaults(…, { size: 'md' })`, the runtime
 *   form `defineProps({ title: String, count: { type: Number, default: 0 } })`, and
 *   `defineEmits` (each event a callback prop: `select` is `onSelect`).
 * - Svelte 5: `let { title, count = 0 }: Props = $props()`; Svelte 4: `export let title: string`.
 *
 * Browser-safe: text in, props out.
 */

export const SFC_FILE = /\.(vue|svelte)$/i;

/** The component's name, from its file ("price-card.vue" → "PriceCard"). */
export function sfcName(path: string): string {
  const base = (path.split('/').pop() ?? path).replace(SFC_FILE, '');
  return base.replace(/(^|[-_.\s]+)(\w)/g, (_m, _s, c: string) => c.toUpperCase()) || 'Component';
}

/** Every <script> block's content (Vue's setup and plain one, Svelte's instance and module). */
function scripts(src: string): string {
  return [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]!).join('\n');
}

/** What's between the brackets that open at `at` ('<' or '(' or '{'), balanced. */
function balanced(text: string, at: number): string | undefined {
  const open = text[at];
  const close = open === '<' ? '>' : open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : undefined;
  if (!close) return undefined;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === open) depth++;
    else if (c === close && !(close === '>' && text[i - 1] === '=')) {
      depth--;
      if (depth === 0) return text.slice(at + 1, i);
    }
  }
  return undefined;
}

const RUNTIME_TYPES: Readonly<Record<string, string>> = { String: 'string', Number: 'number', Boolean: 'boolean', Array: 'unknown[]', Object: 'Record<string, unknown>', Function: '() => void', Date: 'Date' };

/** Vue's runtime props (`{ title: String, count: { type: Number, default: 0, required: true } }`) as a TypeScript type and defaults. */
function runtimeProps(body: string): { type: string; defaults: string[] } {
  const fields: string[] = [];
  const defaults: string[] = [];
  // Top-level `key: value` pairs (values may be objects).
  let i = 0;
  while (i < body.length) {
    const m = /^\s*,?\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*/.exec(body.slice(i));
    if (!m) break;
    i += m[0].length;
    const name = m[1]!;
    let value: string;
    if (body[i] === '{' || body[i] === '[') {
      value = `${body[i]}${balanced(body, i) ?? ''}${body[i] === '{' ? '}' : ']'}`;
    } else value = /^[^,\n}]*/.exec(body.slice(i))![0];
    i += value.length;
    const ctor = /\btype\s*:\s*(\w+)/.exec(value)?.[1] ?? /^\s*(\w+)\s*$/.exec(value)?.[1];
    const required = /\brequired\s*:\s*true/.test(value);
    const fallback = /\bdefault\s*:\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false|null)/.exec(value)?.[1];
    fields.push(`${name}${required ? '' : '?'}: ${RUNTIME_TYPES[ctor ?? ''] ?? 'unknown'}`);
    if (fallback) defaults.push(`${name} = ${fallback}`);
  }
  return { type: `{ ${fields.join('; ')} }`, defaults };
}

/** `withDefaults(defineProps<…>(), { size: 'md', count: 0 })`: the literal defaults, as `name = value`. */
function withDefaults(script: string): string[] {
  const at = /withDefaults\s*\(\s*defineProps\s*</.exec(script);
  if (!at) return [];
  const rest = script.slice(at.index);
  const comma = /\)\s*,\s*\{/.exec(rest);
  if (!comma) return [];
  const body = balanced(rest, comma.index + comma[0].length - 1) ?? '';
  return [...body.matchAll(/(?:^|,)\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false|null)/g)].map((m) => `${m[1]} = ${m[2]}`);
}

/** `defineEmits<{ select: [plan: string] }>()`, its call-signature form, or `defineEmits(['select'])`: callback props. */
function emits(script: string): string[] {
  const at = /defineEmits\s*([<(])/.exec(script) ?? /\bemits\s*:\s*(\[)/.exec(script);
  if (!at) return [];
  const body = balanced(script, at.index + at[0].length - 1) ?? '';
  const names = new Set<string>();
  for (const m of body.matchAll(/['"]([\w:-]+)['"]/g)) names.add(m[1]!);
  for (const m of body.matchAll(/(?:^|[;,{\n])\s*([A-Za-z_$][\w$]*)\s*:/g)) names.add(m[1]!);
  const on = (n: string): string => `on${n.replace(/(^|[-:])(\w)/g, (_m, _s, c: string) => c.toUpperCase())}`;
  return [...names].filter((n) => n !== 'e' && n !== 'event').map((n) => `${on(n)}?: (...args: unknown[]) => void`);
}

/** A Vue component's props as a signature: `(props: {…} & {…emits}) `, with its defaults. */
function vueSignature(script: string): string | undefined {
  const typed = /defineProps\s*</.exec(script);
  // The Composition API's defineProps({ … }), or the Options API's `props: { … }`.
  const plain = /defineProps\s*\(\s*\{/.exec(script) ?? /\bprops\s*:\s*\{/.exec(script);
  const listed = /\bprops\s*:\s*\[([^\]]*)\]/.exec(script) ?? /defineProps\s*\(\s*\[([^\]]*)\]/.exec(script);
  const events = emits(script);
  let type: string | undefined;
  let defaults: string[] = [];
  if (typed) {
    type = balanced(script, typed.index + typed[0].length - 1);
    defaults = withDefaults(script);
  } else if (plain) {
    const read = runtimeProps(balanced(script, plain.index + plain[0].length - 1) ?? '');
    type = read.type;
    defaults = read.defaults;
  }
  else if (listed) type = `{ ${[...listed[1]!.matchAll(/['"]([\w$]+)['"]/g)].map((m) => `${m[1]}?: unknown`).join('; ')} }`;
  if (!type && !events.length) return undefined;
  const all = [type ?? '{}', ...(events.length ? [`{ ${events.join('; ')} }`] : [])].join(' & ');
  return defaults.length ? `({ ${defaults.join(', ')} }: ${all})` : `(props: ${all})`;
}

/** A Svelte component's props as a signature: Svelte 5's `$props()`, or Svelte 4's `export let`. */
function svelteSignature(script: string): string | undefined {
  const runes = /let\s*(\{)/.exec(script);
  if (runes) {
    const pattern = balanced(script, runes.index + runes[0].length - 1);
    const after = runes.index + runes[0].length + (pattern?.length ?? 0) + 1;
    const typed = /^\s*:\s*([^=]+?)\s*=\s*\$props\s*\(/.exec(script.slice(after));
    if (pattern !== undefined && (typed || /^\s*=\s*\$props\s*\(/.test(script.slice(after)))) return `({${pattern}}${typed ? `: ${typed[1]}` : ''})`;
  }
  const lets = [...script.matchAll(/export\s+let\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^=;\n]+?))?\s*(?:=\s*([^;\n]+?))?\s*;?\s*$/gm)];
  if (!lets.length) return undefined;
  const pattern = lets.map((m) => (m[3] ? `${m[1]} = ${m[3]}` : m[1])).join(', ');
  const type = lets.map((m) => `${m[1]}${m[3] ? '?' : ''}: ${m[2]?.trim() ?? 'unknown'}`).join('; ');
  return `({ ${pattern} }: { ${type} })`;
}

/** The component a .vue or .svelte file is, with its props (one per file). */
export function findSfcComponent(path: string, src: string, load?: SourceLoader): ComponentInfo[] {
  const script = scripts(src);
  const signature = /\.vue$/i.test(path) ? vueSignature(script) : svelteSignature(script);
  const name = sfcName(path);
  // The script as TypeScript, with the component as a function the reader knows.
  const read = findComponents(`${script}\nexport default function ${name}${signature ?? '()'} { return null }\n`, load);
  return read.length ? [{ ...read[0]!, name, isDefault: true }] : [{ name, isDefault: true, props: [] }];
}
