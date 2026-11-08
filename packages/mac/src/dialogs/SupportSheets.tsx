import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { SupportAnswer, SupportAsk } from '@beluga/core/support-store.js';
import avatar from '../assets/maintainer.png';
import { Confetti } from '../components/Confetti.js';
import { Icon, type IconName } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { GitHubMark } from '../components/GitHubMark.js';
import { COFFEE_AMOUNTS, COFFEE_LINKS, COFFEE_WORDS, type CoffeeAmount, GITHUB_URL, exactLink, MAINTAINER, closeSupport, useOpenedSupport } from '../lib/support.js';
import { openExternal } from '../lib/system.js';
import { useClock, windowActive } from '../lib/window-active.js';
import s from './support.module.css';

/**
 * The two asks merged work brings (core/support-store.ts): a star on GitHub after the first merge,
 * with confetti, and a coffee after the fifth. They wait for a calm moment (no other sheet up, the
 * window in front), so they never land on top of what you're doing. Opened by hand (Settings ›
 * About, the palette) they're the same sheets, and answering them tells the daemon nothing.
 */
export function SupportSheets() {
  const api = useApi();
  const support = useApp((st) => st.support);
  const opened = useOpenedSupport();
  const calm = useCalmMoment(Boolean(support.due) && !opened);
  const ask: SupportAsk | undefined = opened ?? (calm ? support.due : undefined);
  if (!ask) return null;
  const byHand = opened !== undefined;
  const answer = (a: SupportAnswer): void => {
    if (byHand) closeSupport();
    else void api.support.answer(ask, a);
  };
  return ask === 'star' ? <StarSheet onAnswer={answer} /> : <CoffeeSheet merges={support.merges} byHand={byHand} onAnswer={answer} />;
}

/** True once nothing else has been up for a couple of seconds (latched: the ask's own sheet doesn't undo it). */
function useCalmMoment(waiting: boolean): boolean {
  const [calm, setCalm] = useState(false);
  const quiet = useRef(0);
  // Ticks only while you're looking at the window (lib/window-active.ts).
  const now = useClock(waiting && !calm, 900);
  useEffect(() => {
    if (!waiting) {
      quiet.current = 0;
      return setCalm(false);
    }
    if (calm) return;
    const busy = !windowActive() || document.querySelector('[role="dialog"], [role="alertdialog"]');
    quiet.current = busy ? 0 : quiet.current + 1;
    if (quiet.current > 2) setCalm(true);
  }, [now, waiting, calm]);
  return waiting && calm;
}

/** The maker, as a GitHub chip: their avatar and handle; it opens their profile. */
export function MaintainerChip() {
  return (
    <button type="button" className={s.chip} onClick={() => void openExternal(MAINTAINER.url)} title={`${MAINTAINER.login} on GitHub`}>
      <img src={avatar} alt="" className={s.chipAvatar} draggable={false} />
      <span>{MAINTAINER.login}</span>
      <GitHubMark className={s.mark} />
    </button>
  );
}


/** The shell both asks share: a pastel band with its picture, then the words, then what to do. */
function SupportShell({ tone, art, title, label, onClose, children }: { tone: 'coffee' | 'star'; art: ReactNode; title: string; label: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.sheet} data-support={tone} aria-describedby={undefined} onOpenAutoFocus={(e) => focusMain(e)}>
          <div className={cx(s.band, tone === 'star' ? s.bandStar : s.bandCoffee)}>
            <div className={s.art}>{art}</div>
            <Dialog.Close className={s.close} aria-label={label}>
              <Icon name="x" size={12} />
            </Dialog.Close>
          </div>
          <div className={s.body}>
            <Dialog.Title className={s.title}>{title}</Dialog.Title>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The main button gets the focus, so Return does the kind thing (not the close button). */
function focusMain(e: Event): void {
  const main = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[data-main]');
  if (!main) return;
  e.preventDefault();
  main.focus();
}

/** Three small promises under the title. */
function Promises({ items }: { items: ReadonlyArray<[IconName, string]> }) {
  return (
    <ul className={s.promises}>
      {items.map(([icon, text]) => (
        <li key={text}>
          <Icon name={icon} size={12} />
          {text}
        </li>
      ))}
    </ul>
  );
}

function StarSheet({ onAnswer }: { onAnswer: (a: SupportAnswer) => void }) {
  return (
    <>
      <Confetti />
      <SupportShell tone="star" art={<StarArt />} title="Your first merge with Beluga!" label="Maybe later" onClose={() => onAnswer('later')}>
        <p className={s.lead}>
          Work you made in Beluga just landed. Beluga is free software and a passion project by <MaintainerChip />
        </p>
        <p className={s.why}>Stars are how other people find Beluga, and every single one truly matters. If it has helped you, a star would mean a lot.</p>
        <button
          type="button"
          data-main
          className={s.main}
          onClick={() => {
            void openExternal(GITHUB_URL);
            onAnswer('yes');
          }}
        >
          <Icon name="star" size={14} />
          Star Beluga on GitHub
        </button>
        <div className={s.quiet}>
          <button type="button" className={s.quietButton} onClick={() => onAnswer('later')}>
            Maybe later
          </button>
        </div>
      </SupportShell>
    </>
  );
}

function CoffeeSheet({ merges, byHand, onAnswer }: { merges: number; byHand: boolean; onAnswer: (a: SupportAnswer) => void }) {
  const [amount, setAmount] = useState<CoffeeAmount>(10);
  const give = (link: string): void => {
    void openExternal(link);
    onAnswer('yes');
  };
  return (
    <SupportShell tone="coffee" art={<CupArt />} title="Keep Beluga brewing" label={byHand ? 'Close' : 'Not now'} onClose={() => onAnswer('later')}>
      <p className={s.lead}>
        {byHand || merges < 2 ? '' : `You’ve shipped ${merges} pieces of work with Beluga. `}
        Beluga is a passion project, built and maintained by <MaintainerChip />
      </p>
      <Promises
        items={[
          ['heart', 'Free, always'],
          ['branch', 'Open source'],
          ['check', 'No ads, no paywalls'],
        ]}
      />
      <div className={s.amounts} role="radiogroup" aria-label="Amount">
        {COFFEE_AMOUNTS.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={a === amount}
            className={cx(s.amount, a === amount && s.picked)}
            onClick={() => setAmount(a)}
            onDoubleClick={() => give(COFFEE_LINKS[a])}
          >
            <span className={s.sum}>${a}</span>
            <span className={s.words}>{COFFEE_WORDS[a]}</span>
          </button>
        ))}
      </div>
      <button type="button" data-main className={s.main} onClick={() => give(COFFEE_LINKS[amount])}>
        <Icon name="cup" size={15} />
        Buy a coffee · ${amount}
      </button>
      <button type="button" className={s.other} onClick={() => give(COFFEE_LINKS.other)}>
        Or choose your own amount
        <Icon name="arrowRight" size={11} />
      </button>
      <div className={s.fine}>
        <Icon name="lock" size={11} />
        {exactLink(amount) ? 'Secure checkout by Stripe, in your browser' : `Secure checkout by Stripe: enter $${amount} there`}
      </div>
      <div className={s.quiet}>
        <button type="button" className={s.quietButton} onClick={() => onAnswer('later')}>
          {byHand ? 'Close' : 'Not now'}
        </button>
        {byHand ? null : (
          <>
            <span className={s.dot} aria-hidden="true" />
            <button type="button" className={s.quietButton} onClick={() => onAnswer('never')}>
              Don’t ask again
            </button>
          </>
        )}
      </div>
    </SupportShell>
  );
}

/** A cup on its saucer with a heart on it and steam curling up (still, with less motion asked for). */
function CupArt() {
  return (
    <svg width="112" height="92" viewBox="0 0 112 92" aria-hidden="true" className={s.cupArt}>
      <g className={s.steam} fill="none" strokeWidth="3" strokeLinecap="round">
        <path d="M44 30c-5-6 5-9 0-16" />
        <path d="M56 28c-5-6 5-9 0-16" />
        <path d="M68 30c-5-6 5-9 0-16" />
      </g>
      <ellipse cx="56" cy="80" rx="40" ry="7" className={s.saucer} />
      <path d="M78 46h6a11 11 0 0 1 0 22h-8" fill="none" strokeWidth="5" className={s.handle} />
      <path d="M26 38h56v14a26 26 0 0 1-26 26h-4a26 26 0 0 1-26-26z" className={s.cup} />
      <path d="M26 38h56v5H26z" className={s.rim} />
      <path d="M54 66s-10-5.8-10-12.3a5.2 5.2 0 0 1 10-2 5.2 5.2 0 0 1 10 2C64 60.2 54 66 54 66z" className={s.cupHeart} />
    </svg>
  );
}

/** A soft star with a few small ones around it. */
function StarArt() {
  return (
    <svg width="112" height="92" viewBox="0 0 112 92" aria-hidden="true" className={s.starArt}>
      <path d="M56 12l10.6 21.5 23.7 3.4-17.2 16.7 4.1 23.6L56 66l-21.2 11.2 4.1-23.6-17.2-16.7 23.7-3.4z" className={s.bigStar} strokeLinejoin="round" strokeWidth="3" />
      <path d="M92 14l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z" className={s.smallStar} />
      <path d="M20 54l1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6z" className={s.smallStar} />
      <circle cx="22" cy="20" r="3" className={s.speck} />
      <circle cx="94" cy="62" r="2.5" className={s.speck} />
    </svg>
  );
}
