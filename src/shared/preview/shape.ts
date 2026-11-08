/**
 * What a prop holds, as read from its TypeScript type (preview/props.ts): enough to fill it with
 * a believable value (preview/samples.ts) and to give it a control. Browser-safe: data only.
 */

export type Shape =
  | { readonly kind: 'string' }
  | { readonly kind: 'number' }
  | { readonly kind: 'boolean' }
  /** Something React draws: text, an element. */
  | { readonly kind: 'node' }
  | { readonly kind: 'function' }
  | { readonly kind: 'date' }
  /** A type it couldn't read (an import, a generic): filled from the prop's name, if at all. */
  | { readonly kind: 'unknown'; readonly name?: string }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'union'; readonly of: readonly Shape[] }
  | { readonly kind: 'array'; readonly of: Shape }
  | { readonly kind: 'tuple'; readonly of: readonly Shape[] }
  | { readonly kind: 'object'; readonly fields: readonly Field[] }
  | { readonly kind: 'record'; readonly of: Shape };

export interface Field {
  readonly name: string;
  readonly optional: boolean;
  readonly shape: Shape;
  /** Its JSDoc, shown as the control's tooltip. */
  readonly doc?: string;
  /** The component's own default (`{ size = 'md' }`, or `@default` in its doc). */
  readonly fallback?: unknown;
}

export interface ComponentInfo {
  readonly name: string;
  /** It's the file's default export. */
  readonly isDefault: boolean;
  readonly props: readonly Field[];
  /** Its own JSDoc. */
  readonly doc?: string;
}

/** A field's union reduced to the choices a picker offers (string or number literals), if it's one. */
export function choicesOf(shape: Shape): ReadonlyArray<string | number | boolean> | undefined {
  if (shape.kind === 'boolean') return undefined;
  if (shape.kind !== 'union') return undefined;
  const values = shape.of.filter((s): s is Extract<Shape, { kind: 'literal' }> => s.kind === 'literal' && s.value !== null).map((s) => s.value as string | number | boolean);
  return values.length === shape.of.length && values.length > 1 ? values : undefined;
}

/** A shape with null and undefined taken out of its union (they only say "optional"). */
export function required(shape: Shape): Shape {
  if (shape.kind !== 'union') return shape;
  const of = shape.of.filter((s) => !(s.kind === 'literal' && s.value === null));
  if (of.length === 1) return of[0]!;
  // true | false is just a boolean.
  if (of.length === 2 && of.every((s) => s.kind === 'literal' && typeof s.value === 'boolean')) return { kind: 'boolean' };
  return of.length === shape.of.length ? shape : { kind: 'union', of };
}

/** A grid of numbers (number[][], or tuples of numbers): drawn as a grid to edit. */
export function isNumberGrid(shape: Shape): boolean {
  const rows = shape.kind === 'array' ? [shape.of] : shape.kind === 'tuple' ? shape.of : [];
  return rows.length > 0 && rows.every((r) => (r.kind === 'array' && r.of.kind === 'number') || (r.kind === 'tuple' && r.of.length > 0 && r.of.every((c) => c.kind === 'number')));
}

/** Rows of flat objects (a list of people, plans…): drawn as a small table to edit. */
export function isFlatRows(shape: Shape): boolean {
  if (shape.kind !== 'array' || shape.of.kind !== 'object' || !shape.of.fields.length) return false;
  return shape.of.fields.every((f) => {
    const s = required(f.shape);
    return s.kind === 'string' || s.kind === 'number' || s.kind === 'boolean' || s.kind === 'date' || s.kind === 'node' || (s.kind === 'union' && Boolean(choicesOf(s)));
  });
}
