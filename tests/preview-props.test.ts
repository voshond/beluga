import { describe, expect, it } from 'vitest';
import { findComponents, looksLikeComponents, pickComponent } from '../src/shared/preview/props.js';
import { isMark, sampleProps, sampleValue } from '../src/shared/preview/samples.js';
import { type Field, type Shape, choicesOf, isFlatRows, isNumberGrid } from '../src/shared/preview/shape.js';

/** A shape in a line ("'a'|'b'", "string[]", "{id,name}"), to compare without the whole tree. */
function brief(s: Shape): string {
  switch (s.kind) {
    case 'union':
      return s.of.map(brief).join('|');
    case 'literal':
      return JSON.stringify(s.value);
    case 'array':
      return `${brief(s.of)}[]`;
    case 'tuple':
      return `[${s.of.map(brief).join(',')}]`;
    case 'object':
      return `{${s.fields.map((f) => f.name).join(',')}}`;
    case 'record':
      return `Record<${brief(s.of)}>`;
    default:
      return s.kind;
  }
}
const props = (fields: readonly Field[]): Record<string, string> => Object.fromEntries(fields.map((f) => [`${f.name}${f.optional ? '?' : ''}`, brief(f.shape)]));
const one = (src: string, name?: string) => {
  const c = pickComponent(findComponents(src), name);
  if (!c) throw new Error('no component');
  return c;
};

describe('reading a component’s props from its source', () => {
  const card = `
import './card.css';
type Plan = 'free' | 'pro' | 'team';
interface User { id: string; name: string; email: string; avatarUrl?: string }
export interface PriceCardProps {
  /** The plan's name, on top. */
  plan: Plan;
  price: number;
  features: string[];
  owner: User;
  members: User[];
  matrix: number[][];
  grid: [[number, number, number], [number, number, number]];
  highlighted?: boolean;
  startsAt: Date;
  onSelect: (plan: Plan) => void;
  footer?: React.ReactNode;
  readonly: boolean;
  meta: Record<'views' | 'likes', number>;
  tags: Record<string, string>;
  size?: 'sm' | 'md' | undefined;
}
export default function PriceCard({ plan, price = 24, highlighted = false }: PriceCardProps) {
  // JSX after the signature isn't read: an apostrophe here can't confuse it.
  return <div>Don't {plan} {'}'}</div>;
}`;

  it('follows the props type through aliases, interfaces, arrays, tuples and records', () => {
    expect(props(one(card).props)).toEqual({
      plan: '"free"|"pro"|"team"',
      price: 'number',
      features: 'string[]',
      owner: '{id,name,email,avatarUrl}',
      members: '{id,name,email,avatarUrl}[]',
      matrix: 'number[][]',
      grid: '[[number,number,number],[number,number,number]]',
      'highlighted?': 'boolean',
      startsAt: 'date',
      onSelect: 'function',
      'footer?': 'node',
      readonly: 'boolean',
      meta: '{views,likes}',
      tags: 'Record<string>',
      'size?': '"sm"|"md"|null',
    });
  });

  it('keeps the defaults it destructures, and doc comments as tooltips', () => {
    const fields = one(card).props;
    expect(fields.find((f) => f.name === 'price')?.fallback).toBe(24);
    expect(fields.find((f) => f.name === 'highlighted')?.fallback).toBe(false);
    expect(fields.find((f) => f.name === 'plan')?.doc).toBe("The plan's name, on top.");
  });

  it('finds every exported kind of component, the default first, and leaves the rest', () => {
    const src = `
export const Tiny = ({ label }: { label: string }) => <span>{label}</span>;
const Hidden = () => null;
function Shared({ n }: { n: number }) { return null }
export { Shared as Renamed };
export const Fc: React.FC<{ title: string }> = ({ title }) => <h1>{title}</h1>;
export const Memo = memo(function Memo({ on }: { on: boolean }) { return null });
export default class Clock extends React.Component<{ tz: string; ticks?: number }> { render() { return null } }
export const notAComponent = 3;
export const Colors = { red: '#f00' };
`;
    const found = findComponents(src);
    expect(found.map((c) => c.name)).toEqual(['Clock', 'Tiny', 'Renamed', 'Fc', 'Memo']);
    expect(found[0]!.isDefault).toBe(true);
    expect(props(found.find((c) => c.name === 'Fc')!.props)).toEqual({ title: 'string' });
    expect(props(found.find((c) => c.name === 'Memo')!.props)).toEqual({ on: 'boolean' });
    expect(props(found[0]!.props)).toEqual({ tz: 'string', 'ticks?': 'number' });
  });

  it('reads shadcn components: forwardRef generics, cva variants and their defaults, and children', () => {
    const src = `
const buttonVariants = cva('inline-flex', {
  variants: {
    variant: { default: 'bg-primary', destructive: 'bg-red', outline: 'border' },
    size: { default: 'h-9', sm: 'h-8', lg: 'h-10' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  return <button ref={ref} {...props} />;
});
export { Button, buttonVariants };`;
    const button = one(src);
    expect(button.name).toBe('Button');
    expect(props(button.props)).toEqual({ 'variant?': '"default"|"destructive"|"outline"', 'size?': '"default"|"sm"|"lg"', 'asChild?': 'boolean', 'className?': 'unknown', 'children?': 'node' });
    expect(button.props.find((f) => f.name === 'variant')?.fallback).toBe('default');
  });

  it('reads Pick, Omit, Partial and PropsWithChildren, and a type that names itself without looping', () => {
    const src = `
interface Base { a: string; b: number; c: boolean }
type Node = { label: string; children: Node[] };
export function A(p: Pick<Base, 'a' | 'c'>) { return null }
export function B(p: Partial<Omit<Base, 'a'>>) { return null }
export function C(p: PropsWithChildren<{ x: number }>) { return null }
export function Tree({ root }: { root: Node }) { return null }`;
    const all = findComponents(src);
    expect(props(all.find((c) => c.name === 'A')!.props)).toEqual({ a: 'string', c: 'boolean' });
    expect(props(all.find((c) => c.name === 'B')!.props)).toEqual({ 'b?': 'number', 'c?': 'boolean' });
    expect(props(all.find((c) => c.name === 'C')!.props)).toEqual({ x: 'number', 'children?': 'node' });
    const root = all.find((c) => c.name === 'Tree')!.props[0]!.shape;
    expect(brief(root)).toBe('{label,children}');
  });

  it('reads a JavaScript component from the names it destructures', () => {
    expect(props(one('export function JsCard({ title, items, onClick, isOpen = true }) { return <div/> }').props)).toEqual({ 'title?': 'unknown', 'items?': 'unknown', 'onClick?': 'unknown', 'isOpen?': 'unknown' });
  });

  it('says which files are worth a Preview', () => {
    expect(looksLikeComponents('src/Card.tsx', card)).toBe(true);
    expect(looksLikeComponents('src/Card.test.tsx', card)).toBe(false);
    expect(looksLikeComponents('src/util.ts', card)).toBe(false);
    expect(looksLikeComponents('src/hooks.tsx', 'export function useThing() { return 1 }')).toBe(false);
  });

  it('picks the export asked for, else the default, and nothing for a name it lacks', () => {
    const found = findComponents('export function A() { return null }\nexport default function B() { return null }');
    expect(pickComponent(found)?.name).toBe('B');
    expect(pickComponent(found, 'A')?.name).toBe('A');
    expect(pickComponent(found, 'Nope')).toBeUndefined();
  });

  it('knows a grid and a list of rows when it sees one', () => {
    expect(isNumberGrid({ kind: 'array', of: { kind: 'array', of: { kind: 'number' } } })).toBe(true);
    expect(isNumberGrid({ kind: 'array', of: { kind: 'string' } })).toBe(false);
    expect(isFlatRows({ kind: 'array', of: { kind: 'object', fields: [{ name: 'id', optional: false, shape: { kind: 'string' } }] } })).toBe(true);
    expect(choicesOf({ kind: 'union', of: [{ kind: 'literal', value: 'a' }, { kind: 'literal', value: 'b' }] })).toEqual(['a', 'b']);
  });
});

describe('filling props from the types, without a model', () => {
  const fields = findComponents(`
interface User { name: string; email: string; avatarUrl: string }
export default function Card(p: {
  plan: 'free' | 'pro';
  title: string;
  price: number;
  progress: number;
  members: User[];
  matrix: number[][];
  grid: [[number, number, number], [number, number, number]];
  onSelect: () => void;
  startsAt: Date;
  disabled?: boolean;
  open?: boolean;
  icon?: React.ReactNode;
  subtitle?: string;
}) { return null }`)[0]!.props;
  const out = sampleProps(fields);

  it('gives each prop a believable value from its type and name', () => {
    expect(out.plan).toBe('free');
    expect(out.title).toBe('Quarterly report');
    expect(out.price).toBe(24);
    expect(out.progress).toBe(64);
    expect(out.subtitle).toEqual(expect.any(String));
    const members = out.members as Array<Record<string, string>>;
    expect(members.map((m) => m.name)).toEqual(['Mia Chen', 'Leo Park', 'Ava Stone']);
    expect(members[0]!.email).toBe('mia@example.com');
    expect(members[0]!.avatarUrl).toBe('picture/0-MC.svg');
  });

  it('makes a 2 × 3 matrix for a grid of numbers, counting on', () => {
    expect(out.matrix).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(out.grid).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('marks callbacks and dates for the frame to make real', () => {
    expect(isMark(out.onSelect, 'fn')).toBe(true);
    expect(isMark(out.startsAt, 'date')).toBe(true);
  });

  it('leaves optional switches and slots to the component', () => {
    expect('disabled' in out).toBe(false);
    expect('open' in out).toBe(false);
    expect('icon' in out).toBe(false);
  });

  it('lets the props Claude chose win, and is the same every time', () => {
    expect(sampleProps(fields, { plan: 'pro', title: 'Mine' })).toMatchObject({ plan: 'pro', title: 'Mine', price: 24 });
    expect(sampleProps(fields)).toEqual(out);
  });

  it('fills what a name says when the type is unknown', () => {
    expect(isMark(sampleValue({ kind: 'unknown' }, 'onClick'), 'fn')).toBe(true);
    expect(sampleValue({ kind: 'unknown' }, 'isOpen')).toBe(true);
    expect(Array.isArray(sampleValue({ kind: 'unknown' }, 'items'))).toBe(true);
    expect(sampleValue({ kind: 'unknown' }, 'className')).toBeUndefined();
    expect(sampleValue({ kind: 'string' }, 'cta')).toBe('Get started');
    expect(sampleValue({ kind: 'string' }, 'buttonLabel')).toBe('Get started');
  });
});
