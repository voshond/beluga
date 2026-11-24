import type { CSSProperties } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { type ProviderCard, providerCards } from '@beluga/ui/usage-cards.js';
import { type WindowPace, paceLine, paceOf } from '@beluga/ui/usage-pace.js';
import { agentMark } from '@beluga/shared/agent-marks.js';
import { Icon } from '../components/Icon.js';
import { IconButton, cx } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApp } from '../lib/beluga.js';
import { sameDeep } from '../lib/stable.js';
import { shortcutKeys } from '../lib/shortcuts.js';
import { maskOf } from '../machines/mask.js';
import antigravityLogo from './usage-logos/antigravity-symbolic.svg';
import claudeLogo from './usage-logos/claude-symbolic.svg';
import codexLogo from './usage-logos/codex-symbolic.svg';
import s from './UsagePeek.module.css';

const LOGOS: Readonly<Record<string, string>> = { claude: claudeLogo, codex: codexLogo, antigravity: antigravityLogo };

type ProviderPace = { readonly card: ProviderCard; readonly pace: WindowPace };

const quotaCards = (state: AppState): ProviderCard[] => {
  const selfId = state.self?.peerId ?? state.selfId;
  const me = state.peers.find((p) => p.peerId === selfId) ?? state.self;
  return providerCards(me, state.prefs.defaultAgent, state.runtimes).filter((c) => c.signedIn && c.shape === 'quota');
};

const currentWindow = (card: ProviderCard) => card.windows.find((w) => w.label === '5-hour') ?? card.windows[0];

const providerLine = ({ card }: ProviderPace, now: number): string => [card.agent.label, ...card.windows.map((w) => paceLine(paceOf(w, now)))].join('\n');

type LogoProps = { readonly card: ProviderCard };

const Logo = ({ card }: LogoProps) => {
  const url = LOGOS[card.agent.runtime];
  if (!url) return <Icon name={agentMark(card.agent)} size={13} />;
  return <span className={s.logo} role="img" aria-label={card.agent.label} style={{ maskImage: maskOf(url), WebkitMaskImage: maskOf(url) }} />;
};

type ProviderPeekProps = { readonly provider: ProviderPace; readonly wide: boolean };

const ProviderPeek = ({ provider, wide }: ProviderPeekProps) => {
  const { pace } = provider;
  const style = { '--segments': pace.segments || 1 } as CSSProperties;
  return (
    <span className={s.provider} data-pressure={pace.pressure} title={providerLine(provider, Date.now())}>
      <Logo card={provider.card} />
      <span className={cx(s.track, pace.segments > 1 && s.segmented)} style={style} aria-hidden="true">
        {pace.projected !== undefined ? <span className={s.projected} style={{ width: `${pace.projected}%` }} /> : null}
        <span className={s.fill} style={{ width: `${pace.window.pct}%` }} />
      </span>
      {wide ? <span className={s.pct}>{pace.window.pct}%</span> : null}
    </span>
  );
};

type UsagePeekProps = { readonly wide: boolean };

export const UsagePeek = ({ wide }: UsagePeekProps) => {
  const actions = useActions();
  const cards = useApp(quotaCards, sameDeep);
  const selected = useApp((st) => st.view.kind === 'usage');
  const handleOpen = () => actions.run({ type: 'view', view: { kind: 'usage' } });
  if (!cards.length) return <IconButton icon="gauge" label="Usage" keys={shortcutKeys('go-usage')} active={selected} onClick={handleOpen} />;
  const now = Date.now();
  const providers = cards.flatMap((card) => {
    const w = currentWindow(card);
    return w ? [{ card, pace: paceOf(w, now) }] : [];
  });
  return (
    <button type="button" className={cx(s.peek, wide && s.wide)} data-active={selected || undefined} aria-label="Usage" title={providers.map((p) => providerLine(p, now)).join('\n\n')} onClick={handleOpen}>
      {providers.map((p) => (
        <ProviderPeek key={p.card.key} provider={p} wide={wide} />
      ))}
    </button>
  );
};
