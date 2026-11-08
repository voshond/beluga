import { type HTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode, forwardRef } from 'react';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import s from './Sidebar.module.css';

/** The sidebar's building blocks: a foldable section and a row (used by Sidebar and the friends' sections). */

/** `count`: how many rows it holds. `keep`: what still shows while it's folded (the chat you're in). */
export function Section({ id, title, children, action, count, keep }: { id: string; title: string; children: ReactNode; action?: ReactNode; count?: number; keep?: ReactNode }) {
  const prefs = usePrefs();
  const folded = prefs.folded.includes(id);
  return (
    <section className={s.section}>
      <div className={s.sectionHead}>
        <button type="button" className={s.sectionTitle} onClick={() => setPrefs({ folded: folded ? prefs.folded.filter((f) => f !== id) : [...prefs.folded, id] })} aria-expanded={!folded}>
          {title}
          {count === undefined ? null : <span className={s.sectionCount}>{count}</span>}
          <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={10} className={s.sectionChevron} />
        </button>
        <span className={s.sectionAction}>{action}</span>
      </div>
      {folded ? keep : children}
    </section>
  );
}

export type RowProps = Omit<HTMLAttributes<HTMLDivElement>, 'onClick'> & {
  icon?: ReactNode;
  label: ReactNode;
  selected?: boolean;
  onClick?: (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
  trailing?: ReactNode;
  detail?: string;
  tone?: string;
  indent?: number;
  className?: string;
};

/**
 * A sidebar row. It passes its ref and other props through, so a right-click menu (or a
 * tooltip) wrapped around it can attach.
 */
export const Row = forwardRef<HTMLDivElement, RowProps>(function Row({ icon, label, selected, onClick, trailing, detail, tone, indent = 0, className, onDoubleClick, style, onKeyDown, ...rest }, ref) {
  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      {...rest}
      className={cx(s.row, selected && s.selected, className)}
      style={{ paddingLeft: 8 + indent * 14, ...style }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        // Only the row itself: Enter on a button inside it presses that button.
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.(e);
        }
      }}
      title={detail}
    >
      {icon ? <span className={cx(s.rowIcon, tone)}>{icon}</span> : null}
      <span className={s.rowLabel}>{label}</span>
      {trailing ? <span className={s.trailing}>{trailing}</span> : null}
    </div>
  );
});
