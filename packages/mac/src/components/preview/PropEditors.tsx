import { useEffect, useState } from 'react';
import type { Field } from '@beluga/shared/preview/shape.js';
import { required } from '@beluga/shared/preview/shape.js';
import { pictureOf } from '@beluga/shared/preview/samples.js';
import { Icon } from '../Icon.js';
import { cx } from '../ui.js';
import { fromJson, resizeGrid, toJson } from './preview-model.js';
import s from './preview.module.css';

/**
 * The bigger editors a prop may get (PropControls.tsx): a grid of numbers (a matrix), rows of a
 * list as a small table, and JSON for anything else. Each changes the preview as you type; JSON
 * only once it reads.
 */

const asGrid = (value: unknown): number[][] => (Array.isArray(value) ? value.map((r) => (Array.isArray(r) ? r.map((n) => (typeof n === 'number' ? n : Number(n) || 0)) : [])) : [[0]]);

/** A matrix: one number field per cell, and rows and columns to add or take away. */
export function GridEditor({ value, onChange, label }: { value: unknown; onChange: (v: number[][]) => void; label: string }) {
  const grid = asGrid(value);
  const rows = grid.length;
  const cols = Math.max(1, ...grid.map((r) => r.length));
  const set = (i: number, j: number, n: number): void => onChange(resizeGrid(grid, rows, cols).map((r, ri) => (ri === i ? r.map((c, ci) => (ci === j ? n : c)) : r)));
  return (
    <div className={s.gridEdit} aria-label={label}>
      <div className={s.gridCells} style={{ gridTemplateColumns: `repeat(${cols}, minmax(38px, 56px))` }}>
        {grid.flatMap((r, i) =>
          Array.from({ length: cols }, (_, j) => (
            <input key={`${i}:${j}`} className={s.cell} type="number" value={r[j] ?? 0} aria-label={`${label} row ${i + 1} column ${j + 1}`} onChange={(e) => set(i, j, Number(e.target.value))} />
          )),
        )}
      </div>
      <div className={s.gridSize}>
        <span>
          {rows} × {cols}
        </span>
        <button type="button" className={s.mini} aria-label="One row fewer" disabled={rows <= 1} onClick={() => onChange(resizeGrid(grid, rows - 1, cols))}>
          <Icon name="minus" size={10} /> Row
        </button>
        <button type="button" className={s.mini} aria-label="One more row" onClick={() => onChange(resizeGrid(grid, rows + 1, cols))}>
          <Icon name="plus" size={10} /> Row
        </button>
        <button type="button" className={s.mini} aria-label="One column fewer" disabled={cols <= 1} onClick={() => onChange(resizeGrid(grid, rows, cols - 1))}>
          <Icon name="minus" size={10} /> Column
        </button>
        <button type="button" className={s.mini} aria-label="One more column" onClick={() => onChange(resizeGrid(grid, rows, cols + 1))}>
          <Icon name="plus" size={10} /> Column
        </button>
      </div>
    </div>
  );
}

type Row = Record<string, unknown>;

/** A list of flat objects: a small table, a row per item, with rows to add and take away. */
export function RowsEditor({ field, value, onChange }: { field: Field; value: unknown; onChange: (v: Row[]) => void }) {
  const shape = required(field.shape);
  const columns = shape.kind === 'array' && shape.of.kind === 'object' ? shape.of.fields : [];
  const rows: Row[] = Array.isArray(value) ? value.map((r) => (r && typeof r === 'object' ? (r as Row) : {})) : [];
  const setCell = (i: number, key: string, cell: unknown): void => onChange(rows.map((r, ri) => (ri === i ? { ...r, [key]: cell } : r)));
  const kindOf = (f: Field): string => required(f.shape).kind;
  return (
    <div className={s.rowsEdit}>
      <div className={s.rowsScroll}>
        <table className={s.rowsTable}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.name}>{c.name}</th>
              ))}
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.name}>
                    {kindOf(c) === 'boolean' ? (
                      <input type="checkbox" checked={Boolean(r[c.name])} aria-label={`${c.name}, row ${i + 1}`} onChange={(e) => setCell(i, c.name, e.target.checked)} />
                    ) : pictureOf(r[c.name]) ? (
                      // A sample picture: shown, not spelled out; a link pasted replaces it.
                      <span className={s.pictureCell}>
                        <img src={pictureOf(r[c.name])} alt="" />
                        <input className={s.cell} placeholder="Paste a link" aria-label={`${c.name}, row ${i + 1}`} onChange={(e) => e.target.value && setCell(i, c.name, e.target.value)} />
                      </span>
                    ) : (
                      <input
                        className={s.cell}
                        type={kindOf(c) === 'number' ? 'number' : 'text'}
                        value={r[c.name] === undefined || r[c.name] === null ? '' : typeof r[c.name] === 'object' ? '' : String(r[c.name])}
                        aria-label={`${c.name}, row ${i + 1}`}
                        onChange={(e) => setCell(i, c.name, kindOf(c) === 'number' ? Number(e.target.value) : e.target.value)}
                      />
                    )}
                  </td>
                ))}
                <td>
                  <button type="button" className={s.iconMini} aria-label={`Remove row ${i + 1}`} onClick={() => onChange(rows.filter((_, ri) => ri !== i))}>
                    <Icon name="x" size={10} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className={s.mini} onClick={() => onChange([...rows, { ...(rows.at(-1) ?? {}) }])}>
        <Icon name="plus" size={10} /> Row
      </button>
    </div>
  );
}

/** Anything else, as JSON: applied once it reads, marked while it doesn't. */
export function JsonEditor({ value, onChange, label }: { value: unknown; onChange: (v: unknown) => void; label: string }) {
  const [text, setText] = useState(() => toJson(value));
  const [bad, setBad] = useState(false);
  // The value changed from elsewhere (Reset, a rebuild): show it, unless you're mid-edit on something that doesn't read.
  useEffect(() => {
    if (!bad) setText(toJson(value));
  }, [value]);
  return (
    <textarea
      className={cx(s.json, bad && s.jsonBad)}
      value={text}
      spellCheck={false}
      aria-label={label}
      aria-invalid={bad}
      placeholder="Not set"
      rows={Math.min(8, Math.max(2, text.split('\n').length))}
      onChange={(e) => {
        setText(e.target.value);
        const read = fromJson(e.target.value);
        setBad(!read.ok);
        if (read.ok) onChange(read.value);
      }}
    />
  );
}
