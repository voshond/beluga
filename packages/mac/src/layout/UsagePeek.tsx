import type { CSSProperties } from 'react';
import { usageFor } from '@beluga/agent/usage.js';
import { windowsOf } from '@beluga/ui/usage-cards.js';
import { type WindowPace, paceLine, paceOf, worstPressure } from '@beluga/ui/usage-pace.js';
import { myRuntime } from '../chat/ModelPicker.js';
import { IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import s from './UsagePeek.module.css';

type PeekBarProps = { readonly pace: WindowPace };

const PeekBar = ({ pace }: PeekBarProps) => {
  const style = { '--segments': pace.segments || 1 } as CSSProperties;
  return (
    <span className={s.line} data-pressure={pace.pressure}>
      <span className={s.short}>{pace.window.short}</span>
      <span className={cx(s.track, pace.segments > 1 && s.segmented)} style={style} aria-hidden="true">
        {pace.projected !== undefined ? <span className={s.projected} style={{ width: `${pace.projected}%` }} /> : null}
        <span className={s.fill} style={{ width: `${pace.window.pct}%` }} />
        {pace.elapsed !== undefined ? <span className={s.now} style={{ left: `${pace.elapsed}%` }} /> : null}
      </span>
      <span className={s.pct}>{pace.window.pct}%</span>
    </span>
  );
};

export const UsagePeek = () => {
  const actions = useActions();
  const windows = useApp((st) => windowsOf(usageFor(st.self, myRuntime(st.prefs))).slice(0, 2), sameDeep);
  const selected = useApp((st) => st.view.kind === 'usage');
  const handleOpen = () => actions.run({ type: 'view', view: { kind: 'usage' } });
  if (!windows.length) return <IconButton icon="gauge" label="Usage" keys={shortcutKeys('go-usage')} active={selected} onClick={handleOpen} />;
  const now = Date.now();
  const paces = windows.map((w) => paceOf(w, now));
  return (
    <button type="button" className={s.peek} data-pressure={worstPressure(paces)} data-active={selected || undefined} aria-label="Usage" title={paces.map(paceLine).join('\n')} onClick={handleOpen}>
      {paces.map((p) => (
        <PeekBar key={p.window.label} pace={p} />
      ))}
    </button>
  );
};
