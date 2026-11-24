import type { ClipboardEvent } from 'react';
import { TextInput } from '../components/FormSheet.js';
import { Button, IconButton } from '../components/ui.js';
import { type RefRow, newRow, pastedValues, withPasted } from './initiatives-model.js';
import s from './initiatives.module.css';

type RefListProps = {
  readonly name: string;
  readonly rows: readonly RefRow[];
  readonly onChange: (rows: RefRow[]) => void;
  readonly placeholder: string;
  readonly addLabel: string;
  readonly max?: number;
};

export const RefList = ({ name, rows, onChange, placeholder, addLabel, max = 40 }: RefListProps) => {
  const handleValue = (id: number, value: string): void => onChange(rows.map((row) => (row.id === id ? { ...row, value } : row)));
  const handleLabel = (id: number, label: string): void => onChange(rows.map((row) => (row.id === id ? { ...row, label } : row)));
  const handleRemove = (id: number): void => onChange(rows.filter((row) => row.id !== id));
  const handleAdd = (): void => onChange([...rows, newRow()]);
  const handlePaste = (id: number, event: ClipboardEvent<HTMLInputElement>): void => {
    const values = pastedValues(event.clipboardData.getData('text'));
    if (values.length < 2) return;
    event.preventDefault();
    onChange(withPasted(rows, id, values).slice(0, max));
  };
  return (
    <div className={s.refList} role="group" aria-label={name}>
      {rows.map((row, i) => (
        <div key={row.id} className={s.refRow} data-ref-row={i}>
          <TextInput className={s.refValue} value={row.value} onChange={(value) => handleValue(row.id, value)} onPaste={(event) => handlePaste(row.id, event)} maxLength={500} placeholder={placeholder} aria-label={`${name} ${i + 1}`} />
          <TextInput className={s.refLabel} value={row.label} onChange={(label) => handleLabel(row.id, label)} maxLength={120} placeholder="Label (optional)" aria-label={`Label for ${name.toLowerCase()} ${i + 1}`} />
          <IconButton size="small" icon="x" label={`Remove ${row.label || row.value || `${name.toLowerCase()} ${i + 1}`}`} onClick={() => handleRemove(row.id)} />
        </div>
      ))}
      <div>
        <Button size="small" icon="plus" onClick={handleAdd} disabled={rows.length >= max}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
};
