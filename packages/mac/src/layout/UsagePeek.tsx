import type { CSSProperties } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { type ProviderCard, providerCards } from '@beluga/ui/usage-cards.js';
import { type WindowPace, paceLine, paceOf, worstPressure } from '@beluga/ui/usage-pace.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { Icon } from '../components/Icon.js';
import { IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import s from './UsagePeek.module.css';

type ProviderPace = { readonly card: ProviderCard; readonly paces: readonly WindowPace[] };

const quotaCards = (state: AppState): ProviderCard[] => {
  const selfId = state.self?.peerId ?? state.selfId;
  const me = state.peers.find((p) => p.peerId === selfId) ?? state.self;
  return providerCards(me, state.prefs.defaultAgent, state.runtimes).filter((c) => c.signedIn && c.shape === 'quota');
};

const providerLine = ({ card, paces }: ProviderPace): string => [card.agent.label, ...paces.map(paceLine)].join('\n');

type PeekBarProps = { readonly pace: WindowPace; readonly wide: boolean };

const PeekBar = ({ pace, wide }: PeekBarProps) => {
  const style = { '--segments': pace.segments || 1 } as CSSProperties;
  return (
    <span className={s.line} data-pressure={pace.pressure}>
      {wide ? <span className={s.short}>{pace.window.short}</span> : null}
      <span className={cx(s.track, pace.segments > 1 && s.segmented)} style={style} aria-hidden="true">
        {pace.projected !== undefined ? <span className={s.projected} style={{ width: `${pace.projected}%` }} /> : null}
        <span className={s.fill} style={{ width: `${pace.window.pct}%` }} />
        {pace.elapsed !== undefined ? <span className={s.now} style={{ left: `${pace.elapsed}%` }} /> : null}
      </span>
      {wide ? <span className={s.pct}>{pace.window.pct}%</span> : null}
    </span>
  );
};

type ProviderPeekProps = { readonly provider: ProviderPace; readonly wide: boolean };

const ProviderPeek = ({ provider, wide }: ProviderPeekProps) => (
  <span className={s.provider} data-pressure={worstPressure(provider.paces)} title={providerLine(provider)}>
    <Icon name={agentMark(provider.card.agent)} size={wide ? 13 : 12} />
    <span className={s.bars}>
      {provider.paces.map((p) => (
        <PeekBar key={`${p.window.group ?? ''}:${p.window.label}`} pace={p} wide={wide} />
      ))}
    </span>
  </span>
);

type UsagePeekProps = { readonly wide: boolean };

export const UsagePeek = ({ wide }: UsagePeekProps) => {
  const actions = useActions();
  const cards = useApp(quotaCards, sameDeep);
  const selected = useApp((st) => st.view.kind === 'usage');
  const handleOpen = () => actions.run({ type: 'view', view: { kind: 'usage' } });
  if (!cards.length) return <IconButton icon="gauge" label="Usage" keys={shortcutKeys('go-usage')} active={selected} onClick={handleOpen} />;
  const now = Date.now();
  const providers = cards.map((card) => ({ card, paces: card.windows.slice(0, 2).map((w) => paceOf(w, now)) }));
  return (
    <button type="button" className={cx(s.peek, wide && s.wide)} data-active={selected || undefined} aria-label="Usage" title={providers.map(providerLine).join('\n\n')} onClick={handleOpen}>
      {providers.map((p) => (
        <ProviderPeek key={p.card.key} provider={p} wide={wide} />
      ))}
    </button>
  );
};
