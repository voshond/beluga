import { type WindowAction, ownTitleBar, windowControl } from '../lib/window-frame.js';
import s from './WindowControls.module.css';

type WindowButton = { action: WindowAction; label: string; path: string };

const BUTTONS: readonly WindowButton[] = [
  { action: 'close', label: 'Close window', path: 'M5 5l6 6M11 5l-6 6' },
  { action: 'minimize', label: 'Minimize window', path: 'M5 10.5h6' },
  { action: 'maximize', label: 'Maximize window', path: 'M5.5 5.5h5v5h-5z' },
];

export function WindowControls() {
  if (!ownTitleBar()) return null;
  const handleClick = (action: WindowAction) => () => void windowControl(action).catch(() => undefined);
  return (
    <span className={s.controls}>
      {BUTTONS.map((b) => (
        <button key={b.action} type="button" className={s.button} aria-label={b.label} title={b.label} onClick={handleClick(b.action)}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d={b.path} />
          </svg>
        </button>
      ))}
    </span>
  );
}
