import type { ReactNode } from 'react';
import s from './Inspector.module.css';

/** One section of the right panel. */
export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className={s.panel}>
      <div className={s.panelHead}>
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
