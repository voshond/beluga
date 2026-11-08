import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { AppState } from '@beluga/core/store.js';
import { type StatsSnapshot, dailySeries, streaks, totalsBy, totalsOf } from '@beluga/shared/stats.js';
import { Icon } from '../../components/Icon.js';
import { Button, cx, personColor } from '../../components/ui.js';
import { useAvatarUrl } from '../../lib/avatars.js';
import { drawBack, drawFront, drawStrap, loadPicture } from './card-face.js';
import { calendar, duration } from './stats-model.js';
import { type Title, titlesOf } from './titles.js';
import { Mark } from '../../onboarding/Mark.js';
import { Recap } from './Recap.js';
import { ShareSheet } from './ShareSheet.js';
import type { ShareInput } from './share-image.js';
import { compact } from './usage-model.js';
import { usePicked } from './use-stats.js';
import s from './your-card.module.css';

// three.js comes only with the Usage tab, and only once the card is drawn.
const Lanyard = lazy(() => import('../../components/reactbits/lanyard-props.js'));
type LanyardProps = import('../../components/reactbits/lanyard-props.js').LanyardProps;

/** Your pass on its lanyard (one at a time: the recap's last slide takes it while it's open). */
const pass = (faces: Faces, color: string, size: number, more: Partial<LanyardProps> = {}) => <Lanyard frontImage={faces.front} backImage={faces.back} strapImage={faces.strap} cardColor="#fbfbfd" strapColor={color} finish="glossy" metal="silver" size={size} strapLength={0.42} breeze={0} {...more} />;

/** How tall the card hangs (px) and how far down its top is, whatever the size of the layer it's drawn in. */
const CARD_PX = 430;
const CARD_TOP_PX = 96;
/** The layer reaches this far below your card's box, so the card can swing out over the page. */
export const BLEED_BELOW = 280;

/**
 * Your pass hangs in a layer bigger than its place (over the words, past the edges, down into
 * the next chapter) so it can swing out of its box; the layer takes the pointer only over the card.
 * Lanyard sizes the card to the layer, so it's given the size that keeps the card as it was.
 */
function useLayer(): { ref: React.RefObject<HTMLElement | null>; size: number; strapLength: number; narrow: boolean } {
  const ref = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState({ width: 1000, height: 580 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const narrow = box.width < 736;
  // The layer: the box's height and the bleed (when narrow, the pass's own place: 400 px).
  const tall = (narrow ? 400 : box.height) + BLEED_BELOW;
  const size = Math.min(0.9, CARD_PX / tall);
  // Lanyard puts the card's top at 0.12–0.42 of the layer's height (strapLength 0–1).
  const strapLength = Math.min(1, Math.max(0, (CARD_TOP_PX / tall - 0.12) / 0.3));
  return { ref, size, strapLength, narrow };
}

interface Faces {
  readonly front: string;
  readonly back: string;
  readonly strap: string;
}

/** Your pass number: four digits that are always yours (from your id). */
export function serialOf(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return String(h % 10_000).padStart(4, '0');
}

/** Your name and picture as the network knows them (else this Mac's name). */
function useYou(state: AppState): { name: string; id: string; picture?: string } {
  const self = state.network.self;
  const id = self?.peerId ?? state.selfId;
  const name = self?.name || state.self?.name || 'You';
  const picture = useAvatarUrl(id);
  return { name, id, ...(picture ? { picture } : {}) };
}

/** Everything the card and the titles read from the stats, all time. */
function useStanding(stats: StatsSnapshot, now: number) {
  return useMemo(() => {
    const all = totalsOf(stats, '');
    const agents = [...totalsBy(stats, 'agent', '').entries()].filter(([k, t]) => k && t.agentMs + t.prompts + t.tokens > 0).length;
    const { longest } = streaks(stats, now);
    const year = calendar(dailySeries(stats, 'prompts', now, 371), now)
      .slice(-52)
      .map((w) => w.map((d) => d.level));
    const active = Object.keys(stats.days).length;
    return { all, longest, titles: titlesOf({ all, hours: stats.hours, longestStreak: longest, agents }), year, active };
  }, [stats, now]);
}

/**
 * The top of the Usage tab: your pass on a lanyard (grab it, swing it, flip it) with your picture,
 * name and title, and beside it the title in words, what earned it, and the other titles you've
 * earned (press one to wear it on your pass). The recap starts from here.
 */
export function YourCard({ state, stats, now }: { state: AppState; stats: StatsSnapshot; now: number }) {
  const [recap, setRecap] = useState(false);
  const you = useYou(state);
  const { all, longest, titles, year, active } = useStanding(stats, now);
  const [sharing, setSharing] = useState(false);
  const [worn, setWorn] = usePicked<string>(
    'beluga.usage.title',
    titles[0]!.id,
    titles.map((t) => t.id),
  );
  const title: Title = titles.find((t) => t.id === worn) ?? titles[0]!;
  const since = stats.since ? `Since ${new Date(stats.since).toLocaleDateString([], { month: 'short', year: 'numeric' })}` : 'From today';
  const figures = useMemo(
    () => [
      { value: duration(all.agentMs).replace(' min', 'm'), label: 'agent time' },
      { value: compact(all.prompts), label: 'prompts' },
      all.prsMerged ? { value: compact(all.prsMerged), label: 'PRs merged' } : { value: compact(all.worktrees), label: 'worktrees' },
    ],
    [all],
  );
  const [faces, setFaces] = useState<Faces | undefined>(undefined);
  const key = `${you.name}|${you.picture ?? ''}|${title.id}|${figures.map((f) => f.value).join(',')}|${since}|${stats.hours.join('')}|${active}`;
  useEffect(() => {
    let alive = true;
    void loadPicture(you.picture).then((picture) => {
      if (!alive) return;
      const face = { name: you.name, title: title.name, color: title.color, personColor: personColor(you.id), figures, hours: stats.hours, year, since, serial: serialOf(you.id), active, ...(picture ? { picture } : {}) };
      setFaces({ front: drawFront(face), back: drawBack(face), strap: drawStrap(title.color) });
    });
    return () => {
      alive = false;
    };
    // Drawn again only when what's on it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const others = titles.filter((t) => t.id !== title.id);
  // What the picture to share shows (drawn again only when it changes).
  const shareInput = useMemo<ShareInput | undefined>(
    () =>
      faces
        ? {
            front: faces.front,
            title: title.name,
            why: title.id === 'rookie' ? 'Just getting started' : title.why,
            color: title.color,
            since,
            figures: [
              { value: figures[0]!.value, label: 'with my agents' },
              { value: compact(all.prompts), label: 'prompts sent' },
              all.prsMerged ? { value: compact(all.prsMerged), label: 'pull requests merged' } : { value: compact(all.worktrees), label: 'worktrees made' },
              longest > 1 ? { value: `${longest} days`, label: 'longest streak' } : { value: active.toLocaleString(), label: 'active days' },
            ],
          }
        : undefined,
    [faces, title, since, figures, all, longest, active],
  );
  const layer = useLayer();
  return (
    <section ref={layer.ref} className={s.hero} aria-label="Your card">
      {/* Its place in the layout; the pass itself hangs in the layer below. */}
      <div className={s.lanyard} />
      <div className={cx(s.layer, layer.narrow && s.layerNarrow)}>
        {faces && !recap ? <Suspense fallback={null}>{pass(faces, title.color, layer.size, { strapLength: layer.strapLength, passThrough: true, anchor: layer.narrow ? 'center' : 'left', wiggle: 1 })}</Suspense> : null}
      </div>
      <div className={s.words}>
        <span className={s.brand}>
          <Mark size={30} delay={0.3} />
          Beluga · Usage Pass {new Date(now).getFullYear()}
        </span>
        <span className={s.hi}>Hi {you.name.split(' ')[0]}, you’re a</span>
        <h1 className={s.title}>
          <span className={s.titleMark} style={{ '--t': title.color } as React.CSSProperties}>
            <Icon name={title.icon} size={26} />
          </span>
          {title.name}
        </h1>
        <p className={s.why}>{title.id === 'rookie' ? 'Titles come as your stats grow: send prompts, ship pull requests, keep a streak.' : `Because: ${title.why}.`}</p>
        {others.length ? (
          <div className={s.earned}>
            <span className={s.earnedLabel}>Also earned · press one to wear it</span>
            <div className={s.chips}>
              {others.map((t) => (
                <button key={t.id} type="button" className={s.chip} style={{ '--t': t.color } as React.CSSProperties} title={t.why} onClick={() => setWorn(t.id)}>
                  <Icon name={t.icon} size={13} />
                  {t.name}
                </button>
              ))}
              {title.id !== titles[0]!.id ? (
                <button type="button" className={cx(s.chip, s.chipBack)} onClick={() => setWorn(titles[0]!.id)}>
                  Back to {titles[0]!.name}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className={s.foot}>
          <Button variant="primary" icon="play" onClick={() => setRecap(true)}>
            Play Your Recap
          </Button>
          <Button variant="plain" icon="share" onClick={() => setSharing(true)} disabled={!faces}>
            Share…
          </Button>
          <span className={s.since}>
            {since} · {active.toLocaleString()} active {active === 1 ? 'day' : 'days'}
          </span>
        </div>
      </div>
      {recap ? <Recap state={state} stats={stats} now={now} title={title} pass={faces ? <Suspense fallback={null}>{pass(faces, title.color, 0.5)}</Suspense> : undefined} onShare={() => (setRecap(false), setSharing(true))} onClose={() => setRecap(false)} /> : null}
      {sharing && shareInput ? <ShareSheet input={shareInput} onClose={() => setSharing(false)} /> : null}
    </section>
  );
}
