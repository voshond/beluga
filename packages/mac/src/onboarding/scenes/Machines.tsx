import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Icon, type IconName } from '../../components/Icon.js';
import { MachineMark } from '../../machines/MachineMark.js';
import { usePrefs } from '../../lib/prefs.js';
import { thisComputer, upFirst } from '../../lib/os-words.js';
import { SPRING } from '../fx.js';
import { useBeats } from './use-beats.js';
import s from './scenes.module.css';
import m from './machines.module.css';

/**
 * Your computers (BLG-813): the app stays here, the work goes where you send it. This Mac and
 * your phone are wired to a Mac mini at home (your Always On), build-box on AWS and a Linux box. A
 * task's Runs on flips to AWS, the task hops there and its steps stream back to the chat. Then
 * the lid closes, and the phone keeps up until it's done.
 */

interface Machine {
  readonly id: 'mini' | 'aws' | 'linux';
  readonly icon: IconName;
  /** What its own mark is drawn from (the AWS logo, Ubuntu's), instead of the glyph. */
  readonly mark?: { readonly kind: 'aws' | 'linux'; readonly platform: 'linux'; readonly distro?: 'ubuntu' };
  readonly name: string;
  readonly where: string;
  readonly hue: number;
}

const MACHINES: readonly Machine[] = [
  { id: 'mini', icon: 'macMini', name: 'Mac mini', where: 'At home', hue: 160 },
  { id: 'aws', icon: 'cloud', mark: { kind: 'aws', platform: 'linux' }, name: 'build-box', where: 'AWS · us-east-1', hue: 250 },
  { id: 'linux', icon: 'server', mark: { kind: 'linux', platform: 'linux', distro: 'ubuntu' }, name: 'Linux box', where: 'Ubuntu · office', hue: 60 },
];

/** What the AWS mark is drawn from: an AWS computer's kind. */
const AWS_MARK = { kind: 'aws', platform: 'linux' } as const;

const STEPS: ReadonlyArray<{ icon: IconName; text: string; code?: string; short: string }> = [
  { icon: 'terminal', text: 'Ran', code: 'npm ci', short: 'npm ci' },
  { icon: 'terminal', text: 'Ran', code: 'npm run test:e2e', short: 'test:e2e' },
  { icon: 'check', text: '214 tests passed', short: '214 passed' },
];

// Beats: the task on this Mac · Runs on flips to AWS · it hops there · two steps stream back ·
// the lid closes · the phone gets the last step · done.
const BEATS = [1400, 800, 1000, 900, 1100, 1500, 1000, 2600] as const;
const PICKED = 1;
const HOP = 2;
const RUNNING = 3;
/** Reduce Motion holds here: on AWS, two steps in, the chat on this Mac and the phone. */
const REST = 4;
const CLOSED = 5;
const DONE = 7;

/** The wires, in the wire column's own pixels (96 × 336): this Mac and the phone meet, then fan out. */
const WIRE = {
  mac: 'M0 80 C 22 80, 18 168, 34 168',
  phone: 'M0 272 C 22 272, 18 168, 34 168',
  mini: 'M34 168 C 64 168, 62 48, 96 48',
  aws: 'M34 168 L96 168',
  linux: 'M34 168 C 64 168, 62 288, 96 288',
} as const;
const TO_AWS = 'M0 80 C 22 80, 18 168, 34 168 L96 168';
const AWS_TO_MAC = 'M96 168 L34 168 C 18 168, 22 80, 0 80';
const AWS_TO_PHONE = 'M96 168 L34 168 C 18 168, 22 272, 0 272';
const TRAVEL = { duration: 0.9, ease: [0.45, 0, 0.2, 1] as const };

const shownAt = (beat: number): number => (beat < RUNNING ? 0 : beat < CLOSED ? beat - RUNNING + 1 : beat < CLOSED + 1 ? 2 : 3);

function Beam({ d, id }: { readonly d: string; readonly id: string }) {
  return <motion.path key={id} d={d} stroke="url(#machinesBeam)" strokeWidth="2.5" fill="none" initial={{ pathLength: 0.3, pathOffset: 0 }} animate={{ pathOffset: 1 }} transition={TRAVEL} />;
}

function Packet({ d, icon, tone }: { readonly d: string; readonly icon: IconName; readonly tone?: 'ok' }) {
  return (
    <span className={m.packet} data-tone={tone} style={{ offsetPath: `path('${d}')` }}>
      <Icon name={icon} size={11} />
    </span>
  );
}

function Status({ machine, beat, still }: { readonly machine: Machine; readonly beat: number; readonly still: boolean }) {
  if (machine.id === 'mini') {
    return (
      <span className={m.always}>
        <Icon name="power" size={10} /> Always On
      </span>
    );
  }
  if (machine.id === 'linux' || beat < HOP) return <span className={s.dim}>Ready</span>;
  if (beat >= DONE) {
    return (
      <span className={m.state}>
        <Icon name="check" size={11} className={s.done} /> Done
      </span>
    );
  }
  return (
    <span className={m.state}>
      <Icon name="refresh" size={11} className={still ? m.live : s.spin} /> {beat === HOP ? 'Starting the task' : 'Running the e2e suite'}
    </span>
  );
}

export function Machines() {
  const beat = useBeats(BEATS, REST);
  const still = (useReducedMotion() ?? false) || usePrefs().reduceMotion;
  const onAws = beat >= PICKED;
  const closed = beat >= CLOSED;
  const shown = shownAt(beat);
  const live = (i: number) => i === shown - 1 && beat < DONE;
  const working = beat >= HOP;
  const streaming = beat === RUNNING || beat === REST;

  return (
    <div className={s.stage}>
      <div className={m.machines}>
        <div className={m.devices}>
          <motion.div className={m.mac} animate={{ opacity: closed ? 0.55 : 1, scale: closed ? 0.97 : 1 }} transition={SPRING}>
            <div className={m.head}>
              <span className={m.tile} style={{ ['--hue' as string]: 40 }}>
                <Icon name="laptop" size={14} />
              </span>
              <div>
                <strong>{upFirst(thisComputer())}</strong>
                <span className={m.sub}>Your Beluga app</span>
              </div>
            </div>
            <AnimatePresence mode="popLayout" initial={false}>
              {closed ? (
                <motion.div key="lid" className={m.lid} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={SPRING}>
                  <Icon name="laptop" size={20} />
                  <strong>Lid closed</strong>
                  <span className={m.sub}>The task carries on</span>
                </motion.div>
              ) : (
                <motion.div key="chat" className={m.body} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={SPRING}>
                  <span className={m.ask}>Run the e2e suite</span>
                  <div className={s.steps}>
                    {STEPS.slice(0, shown).map((st, i) => (
                      <motion.div key={st.short} className={`${s.step} ${m.line}`} initial={still ? false : { opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={SPRING}>
                        <Icon name={live(i) ? 'refresh' : st.icon} size={12} className={live(i) ? (still ? m.live : s.spin) : s.done} />
                        <span>{st.text}</span>
                        {st.code ? <code>{st.code}</code> : null}
                      </motion.div>
                    ))}
                  </div>
                  <div className={m.composer}>
                    <span className={m.chip}>
                      <Icon name="claude" size={10} /> Opus
                    </span>
                    <motion.span key={String(onAws)} className={m.chip} data-on={onAws || undefined} initial={still || !onAws ? false : { scale: 0.86 }} animate={{ scale: 1 }} transition={SPRING}>
                      {onAws ? <MachineMark machine={AWS_MARK} size={10} /> : <Icon name="laptop" size={10} />} Runs on {onAws ? 'build-box' : thisComputer()}
                    </motion.span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          <span className={m.note}>
            <Icon name="lock" size={10} /> Paired to you, end-to-end encrypted
          </span>

          <div className={m.phone} data-keeps-up={closed || undefined}>
            <span className={m.notch} />
            <span className={m.phoneHead}>
              <Icon name="cloud" size={9} /> e2e suite
            </span>
            {STEPS.slice(0, shown).map((st, i) => (
              <span key={st.short} className={m.phoneLine}>
                <Icon name={live(i) ? 'refresh' : st.icon} size={9} className={live(i) ? (still ? m.live : s.spin) : s.done} />
                {st.short}
              </span>
            ))}
            {shown === 0 ? <span className={`${m.phoneLine} ${s.dim}`}>Following</span> : null}
          </div>
        </div>

        <div className={m.wire}>
          <svg className={m.wireSvg} viewBox="0 0 96 336" aria-hidden="true">
            <defs>
              <linearGradient id="machinesBeam" x1="0" x2="1">
                <stop offset="0" stopColor="var(--claude)" stopOpacity="0" />
                <stop offset="0.5" stopColor="var(--claude)" stopOpacity="1" />
                <stop offset="1" stopColor="var(--claude)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={WIRE.mac} className={m.wireBase} data-live={(working && !closed) || undefined} data-off={closed || undefined} />
            <path d={WIRE.phone} className={m.wireBase} data-live={working || undefined} />
            <path d={WIRE.mini} className={m.wireBase} />
            <path d={WIRE.aws} className={m.wireBase} data-live={working || undefined} />
            <path d={WIRE.linux} className={m.wireBase} />
            <circle cx="34" cy="168" r="3" className={m.junction} />
            {still ? null : (
              <>
                {beat === HOP ? <Beam id="hop" d={TO_AWS} /> : null}
                {streaming ? <Beam id={`mac-${beat}`} d={AWS_TO_MAC} /> : null}
                {beat >= RUNNING && beat !== CLOSED ? <Beam id={`phone-${beat}`} d={AWS_TO_PHONE} /> : null}
              </>
            )}
          </svg>
          {still ? null : beat === HOP ? <Packet key="hop" d={TO_AWS} icon="claude" /> : beat === DONE ? <Packet key="done" d={AWS_TO_PHONE} icon="check" tone="ok" /> : null}
        </div>

        <div className={m.list}>
          {MACHINES.map((mc) => (
            <div key={mc.id} className={m.machine} data-busy={(mc.id === 'aws' && working && beat < DONE) || undefined}>
              <div className={m.head}>
                <span className={m.tile} style={{ ['--hue' as string]: mc.hue }}>
                  {mc.mark ? <MachineMark machine={mc.mark} size={14} /> : <Icon name={mc.icon} size={14} />}
                </span>
                <div>
                  <strong>{mc.name}</strong>
                  <span className={m.sub}>{mc.where}</span>
                </div>
              </div>
              <div className={m.status}>
                <Status machine={mc} beat={beat} still={still} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
