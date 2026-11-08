import type { ReactNode } from 'react';
import type { Field } from '@beluga/shared/preview/shape.js';
import { pictureOf } from '@beluga/shared/preview/samples.js';
import { Icon } from '../Icon.js';
import { Select } from '../Select.js';
import { Tip, cx } from '../ui.js';
import { GridEditor, JsonEditor, RowsEditor } from './PropEditors.js';
import { choiceLabels, controlOf, dateAt, dayOf, startValue } from './preview-model.js';
import s from './preview.module.css';

/**
 * A live preview's props, one row each with the control its type calls for (preview-model.ts
 * controlOf): choices, switches, numbers, text, colours, pictures, dates, matrices, lists as small
 * tables, JSON. A prop's doc comment is its tooltip; callbacks show how often they fired. Each
 * change goes straight to the frame, no rebuild.
 */

export interface PropControlsProps {
  readonly fields: readonly Field[];
  readonly values: Readonly<Record<string, unknown>>;
  readonly onChange: (name: string, value: unknown) => void;
  /** Take a prop out (the component's own default applies). */
  readonly onClear: (name: string) => void;
  /** How many times each callback fired. */
  readonly fired: Readonly<Record<string, number>>;
}

export function PropControls({ fields, values, onChange, onClear, fired }: PropControlsProps) {
  if (!fields.length) return <div className={s.propsEmpty}>It takes no props.</div>;
  return (
    <div className={s.props}>
      {fields.map((f) => (
        <PropRow key={f.name} field={f} value={values[f.name]} set={f.name in values} onChange={(v) => onChange(f.name, v)} onClear={() => onClear(f.name)} fired={fired[f.name] ?? 0} />
      ))}
    </div>
  );
}

function PropRow({ field, value, set, onChange, onClear, fired }: { field: Field; value: unknown; set: boolean; onChange: (v: unknown) => void; onClear: () => void; fired: number }) {
  const kind = controlOf(field, value);
  const name = (
    <span className={cx(s.propName, field.doc && s.propDoc)}>
      {field.name}
      {field.optional ? <em className={s.optional}>?</em> : null}
    </span>
  );
  const unset = !set && kind !== 'event';
  const wide = kind === 'grid' || kind === 'rows' || kind === 'json' || kind === 'longText';
  return (
    <div className={cx(s.prop, wide && s.propWide)} data-prop={field.name}>
      <div className={s.propHead}>
        {field.doc ? <Tip label={field.doc}>{name}</Tip> : name}
        <span className={s.grow} />
        {set && field.optional && kind !== 'event' ? (
          <button type="button" className={s.iconMini} aria-label={`Use ${field.name}’s default`} title="Use its default" onClick={onClear}>
            <Icon name="x" size={9} />
          </button>
        ) : null}
      </div>
      <div className={s.propControl}>{unset ? <Unset field={field} onSet={() => onChange(startValue(field))} /> : <Control field={field} kind={kind} value={value} onChange={onChange} fired={fired} />}</div>
    </div>
  );
}

/** A prop left to the component: its default, and a way to set it. */
function Unset({ field, onSet }: { field: Field; onSet: () => void }) {
  const fallback = field.fallback !== undefined ? (typeof field.fallback === 'string' ? `“${field.fallback}”` : JSON.stringify(field.fallback)) : undefined;
  return (
    <button type="button" className={s.unset} onClick={onSet}>
      {fallback ? `Default ${fallback}` : 'Not set'}
      <span className={s.setIt}>Set</span>
    </button>
  );
}

function Control({ field, kind, value, onChange, fired }: { field: Field; kind: ReturnType<typeof controlOf>; value: unknown; onChange: (v: unknown) => void; fired: number }): ReactNode {
  const label = field.name;
  switch (kind) {
    case 'choice': {
      const choices = choiceLabels(field.shape);
      if (choices.length <= 4 && choices.every((c) => c.label.length <= 10)) {
        return (
          <div className={s.choices} role="radiogroup" aria-label={label}>
            {choices.map((c) => (
              <button key={c.label} type="button" role="radio" aria-checked={value === c.value} className={cx(s.choice, value === c.value && s.choiceOn)} onClick={() => onChange(c.value)}>
                {c.label}
              </button>
            ))}
          </div>
        );
      }
      return <Select size="small" label={label} value={String(value ?? '')} options={choices.map((c) => ({ value: c.label, label: c.label }))} onChange={(v) => onChange(choices.find((c) => c.label === v)?.value ?? v)} />;
    }
    case 'switch':
      return <button type="button" role="switch" aria-checked={Boolean(value)} aria-label={label} className={cx(s.switch, Boolean(value) && s.switchOn)} onClick={() => onChange(!value)} />;
    case 'number':
      return <input className={s.field} type="number" value={typeof value === 'number' && Number.isFinite(value) ? value : ''} aria-label={label} onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />;
    case 'date':
      return <input className={s.field} type="date" value={dayOf(value)} aria-label={label} onChange={(e) => e.target.value && onChange(dateAt(e.target.value))} />;
    case 'color':
      return (
        <span className={s.colorField}>
          <input type="color" value={String(value)} aria-label={`${label} colour`} onChange={(e) => onChange(e.target.value)} />
          <input className={s.field} value={String(value ?? '')} aria-label={label} onChange={(e) => onChange(e.target.value)} />
        </span>
      );
    case 'picture':
      return (
        <span className={s.pictureField}>
          <img src={pictureOf(value)} alt="" />
          <input className={s.field} placeholder="A sample picture · paste a link" aria-label={label} onChange={(e) => e.target.value && onChange(e.target.value)} />
        </span>
      );
    case 'longText':
      return <textarea className={s.field} rows={2} value={String(value ?? '')} aria-label={label} onChange={(e) => onChange(e.target.value)} />;
    case 'text':
      return <input className={s.field} value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''} aria-label={label} onChange={(e) => onChange(e.target.value)} />;
    case 'event':
      return <span className={cx(s.fired, fired > 0 && s.firedOn)}>{fired ? `Fired ${fired === 1 ? 'once' : `${fired} times`}` : 'Fires when used'}</span>;
    case 'grid':
      return <GridEditor value={value} label={label} onChange={onChange} />;
    case 'rows':
      return <RowsEditor field={field} value={value} onChange={onChange} />;
    case 'json':
      return <JsonEditor value={value} label={label} onChange={onChange} />;
  }
}
