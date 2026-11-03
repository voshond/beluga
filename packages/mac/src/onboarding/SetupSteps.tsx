import { motion } from 'motion/react';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { STARTERS, type FireLook, DEFAULT_FIRE, presetOf, starterOf } from '../chat/fire-look.js';
import { Preview } from '../dialogs/FireSettings.js';
import { Switch } from '../dialogs/settings-controls.js';
import { previewRequestPopup } from '../gateway/request-native.js';
import { useApi, useApp } from '../lib/beluga.js';
import { askNotificationPermission, openNotificationSettings, useNotificationAccess } from '../lib/sounds/access.js';
import { ACCENTS, type Accent, type UiPrefs, baseNow, getPrefs, pickTheme, setPrefs, usePrefs } from '../lib/prefs.js';
import { type AppTheme, THEMES, themeFor } from '../lib/themes.js';
import { useDocTheme } from '../components/markdown/use-doc-theme.js';
import { EASE_OUT, Rise, SPRING, Words } from './fx.js';
import { Glass } from './Glass.js';
import s from './onboarding.module.css';
import { cmdReturn, notificationSettings, returnName, systemSettingsName } from '../lib/os-words.js';
import { keyPlatform } from '../lib/shortcuts-model.js';

type Appearance = UiPrefs['appearance'];

/** A tiny Beluga window in one theme's colours: sidebar, a conversation, the box you type in. */
function MiniApp({ theme }: { readonly theme: AppTheme }) {
  const k = theme.colors;
  const vars = { '--m-bg': k.bg, '--m-side': k.sidebar, '--m-line': `color-mix(in srgb, ${k.text3} 40%, ${k.bg})`, '--m-strong': `color-mix(in srgb, ${k.text2} 45%, ${k.bg})`, '--m-claude': k.claude } as CSSProperties;
  return (
    <span className={s.mini} data-look={theme.base} style={vars}>
      <span className={s.miniSide}>
        <i />
        <i />
        <i data-on />
        <i />
      </span>
      <span className={s.miniMain}>
        <i data-w="70" />
        <i data-w="45" data-claude />
        <i data-w="58" />
        <span className={s.miniBox} />
      </span>
    </span>
  );
}

/**
 * The themes for the look showing (BLG-696): a swatch each, its own background with its accent at
 * the centre, and the picked one's name beside them. Settings › Appearance has them all as windows.
 */
function ThemeRow({ prefs }: { readonly prefs: UiPrefs }) {
  const base = useDocTheme();
  const picked = themeFor(base, prefs);
  const [hover, setHover] = useState<AppTheme>();
  return (
    <Rise delay={0.45} className={s.accentRow}>
      <span className={cx(s.label, s.themeLabel)}>Theme</span>
      <div className={s.swatches} role="radiogroup" aria-label={base === 'dark' ? 'Dark theme' : 'Light theme'} onMouseLeave={() => setHover(undefined)}>
        {THEMES.filter((th) => th.base === base).map((th) => (
          <motion.button
            key={th.id}
            type="button"
            role="radio"
            aria-label={th.name}
            aria-checked={picked.id === th.id}
            className={cx(s.swatch, s.themeSwatch)}
            style={{ background: th.colors.bg, '--t-dot': th.accent ?? th.colors.text2, '--t-edge': th.colors.sidebar } as CSSProperties}
            onClick={() => pickTheme(th.id)}
            onMouseEnter={() => setHover(th)}
            onFocus={() => setHover(th)}
            whileHover={{ scale: 1.15 }}
            whileTap={{ scale: 0.92 }}
          >
            {picked.id === th.id ? <motion.span layoutId={`theme-ring-${base}`} className={s.swatchRing} transition={SPRING} /> : null}
          </motion.button>
        ))}
      </div>
      <span className={s.themeName} aria-live="polite">
        {(hover ?? picked).name}
      </span>
    </Rise>
  );
}

const LOOKS: ReadonlyArray<{ value: Appearance; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** Pick a look: three windows to choose from, and the accent. It all applies as you pick. */
export function Look() {
  const prefs = usePrefs();
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="Make it yours." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        Pick a look and a theme. It changes as you choose, and Settings has them whenever you want another.
      </Rise>
      <div className={s.looks} role="radiogroup" aria-label="Appearance">
        {LOOKS.map((l, i) => {
          const on = prefs.appearance === l.value;
          return (
            <motion.button
              key={l.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={cx(s.lookCard, on && s.lookOn)}
              onClick={() => setPrefs({ appearance: l.value })}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              whileHover={{ y: -3 }}
              transition={{ ...SPRING, delay: 0.25 + i * 0.07 }}
            >
              {l.value === 'system' ? (
                <span className={s.split}>
                  <MiniApp theme={themeFor('light', prefs)} />
                  <MiniApp theme={themeFor('dark', prefs)} />
                </span>
              ) : (
                <MiniApp theme={themeFor(l.value, prefs)} />
              )}
              <span className={s.lookLabel}>
                <span className={s.radio}>{on ? <motion.span layoutId="look-dot" className={s.radioDot} transition={SPRING} /> : null}</span>
                {l.label}
              </span>
            </motion.button>
          );
        })}
      </div>
      <ThemeRow prefs={prefs} />
      <Rise delay={0.5} className={cx(s.accentRow, s.accentAfter)}>
        <span className={s.label}>Accent</span>
        <div className={s.swatches} role="radiogroup" aria-label="Accent">
          {(Object.keys(ACCENTS) as Accent[]).filter((a) => a !== 'theme' || themeFor(baseNow(prefs), prefs).accent).map((a) => (
            <motion.button
              key={a}
              type="button"
              role="radio"
              aria-label={a === 'system' ? 'System accent' : a === 'theme' ? `${themeFor(baseNow(prefs), prefs).name}’s own accent` : a}
              aria-checked={prefs.accent === a}
              className={s.swatch}
              style={{ background: a === 'system' ? 'conic-gradient(#3b82f6, #8b5cf6, #e11d48, #d97706, #059669, #3b82f6)' : ACCENTS[a] }}
              onClick={() => setPrefs({ accent: a })}
              whileHover={{ scale: 1.15 }}
              whileTap={{ scale: 0.92 }}
            >
              {prefs.accent === a ? <motion.span layoutId="accent-ring" className={s.swatchRing} transition={SPRING} /> : null}
            </motion.button>
          ))}
        </div>
      </Rise>
    </div>
  );
}

/** A choice of two or three, the selection sliding between them. */
function Choice<T extends string>({ label, value, options, onChange }: { readonly label: string; readonly value: T; readonly options: ReadonlyArray<{ value: T; label: string }>; readonly onChange: (v: T) => void }) {
  return (
    <div className={s.choice} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(s.choiceItem, value === o.value && s.choiceOn)} onClick={() => onChange(o.value)}>
          {value === o.value ? <motion.span layoutId={`choice-${label}`} className={s.choicePill} transition={SPRING} /> : null}
          <span className={s.choiceLabel}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function SetupRow({ label, detail, children, index }: { readonly label: string; readonly detail: ReactNode; readonly children: ReactNode; readonly index: number }) {
  return (
    <motion.div className={s.row} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE_OUT, delay: 0.25 + index * 0.06 }}>
      <div className={s.rowText}>
        <span className={s.rowLabel}>{label}</span>
        <span className={s.rowDetail}>{detail}</span>
      </div>
      <div className={s.rowControl}>{children}</div>
    </motion.div>
  );
}

/**
 * The message box's fire: two pixel fires or none, tried in a box like the real one as you pick.
 * Someone still on the default starts on Arcade; a look of their own is left alone until they pick.
 */
export function Fire() {
  const look = usePrefs().maxFire;
  const set = (patch: Partial<FireLook>): void => {
    const next = { ...getPrefs().maxFire, ...patch };
    setPrefs({ maxFire: { ...next, preset: presetOf(next) } });
  };
  useEffect(() => {
    const now = getPrefs().maxFire;
    const untouched = (['preset', 'show', 'typing', 'popDelete', 'border'] as const).every((k) => now[k] === DEFAULT_FIRE[k]);
    if (untouched) set(STARTERS[0]!.set);
  }, []);
  const picked = starterOf(look);
  const starter = STARTERS.find((x) => x.id === picked);
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="Set your words on fire." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        On Max effort, the box you type in burns. Pick one and type below to try it; Settings › Fire & Confetti has the rest.
      </Rise>
      <Rise delay={0.3} className={s.fireTry}>
        <Preview look={look} className={s.fireStage} />
      </Rise>
      <Glass radius={16} width="100%" className={s.fireRows}>
        <SetupRow index={0} label={starter?.name ?? 'Your own'} detail={starter?.blurb ?? 'Tuned in Settings. Pick one to change it.'}>
          <Choice label="Fire" value={picked ?? ''} onChange={(id) => set(STARTERS.find((x) => x.id === id)!.set)} options={STARTERS.map((x) => ({ value: x.id, label: x.name }))} />
        </SetupRow>
        {picked !== 'none' ? (
          <SetupRow index={1} label="Where it burns" detail={look.where === 'max' ? 'Only on Max effort, so it tells you you’re on Max.' : 'With every model and effort.'}>
            <Choice
              label="Where it burns"
              value={look.where}
              onChange={(where) => set({ where })}
              options={[
                { value: 'max', label: 'On Max Only' },
                { value: 'everywhere', label: 'Everywhere' },
              ]}
            />
          </SetupRow>
        ) : null}
      </Glass>
    </div>
  );
}

/**
 * When something needs you (Claude asks, a decision of yours in a plan, a friend's request): a
 * card in the corner of the screen, over any app, full-screen ones too. It needs no macOS
 * permission; notifications (asked for here) are the fallback and fill Notification Center.
 */
export function Popups() {
  const api = useApi();
  const notify = useApp((st) => st.prefs.notify);
  const [asked, setAsked] = useState<'no' | 'asking' | 'done'>('no');
  // What macOS says (checked again as you come back from System Settings).
  const { access, recheck } = useNotificationAccess();
  const state = access?.state;
  // Where they wait once shown: Notification Center on a Mac and Windows; Linux desktops differ.
  const kept = keyPlatform() === 'linux' ? '' : ', and stay in Notification Center';
  const ask = (): void => {
    setAsked('asking');
    void askNotificationPermission()
      .catch(() => undefined)
      .then((a) => {
        setAsked('done');
        recheck(a);
      });
  };
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="Never miss it when your agent needs you." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        When your agent asks you something, a plan waits on your decision, or a friend asks your agent, a small card shows in the corner of your screen, over whatever you’re doing, full-screen apps too. It never takes the keyboard from you.
      </Rise>
      <Glass radius={16} width="100%" className={s.rows}>
        <SetupRow index={0} label="Show on-screen popups when something needs me" detail="Needs no permission. Off: you still get notifications.">
          <Switch label="Show on-screen popups when something needs me" on={notify.popup !== false} onChange={(v) => void api.session.setPrefs({ notify: { ...notify, popup: v } })} />
        </SetupRow>
        <SetupRow index={1} label="See one now" detail="A pretend friend’s request and a pretend decision, for a minute. Their buttons do nothing.">
          <button type="button" className={cx(s.input, s.rowButton)} onClick={previewRequestPopup}>
            Show Me a Sample
          </button>
        </SetupRow>
        <SetupRow
          index={2}
          label="Notifications too"
          detail={
            state === 'allowed'
              ? `Allowed. They reach you when popups are off${kept}.`
              : state === 'off'
                ? `Turned off for Beluga in ${notificationSettings()}.`
                : asked === 'done'
                  ? `Asked. You can change it in ${notificationSettings()}.`
                  : `Optional.${keyPlatform() === 'mac' ? ' macOS asks once.' : ''} They reach you when popups are off${kept}.`
          }
        >
          {state === 'allowed' ? (
            <span className={s.grant} data-grant="granted">
              <Icon name="check" size={11} /> Allowed
            </span>
          ) : state === 'off' ? (
            <button type="button" className={cx(s.input, s.rowButton)} onClick={() => void openNotificationSettings()}>
              Open {systemSettingsName()}
            </button>
          ) : (
            <button type="button" className={cx(s.input, s.rowButton)} disabled={asked !== 'no'} onClick={ask}>
              {asked === 'done' ? 'Asked' : asked === 'asking' ? 'Asking…' : 'Allow Notifications'}
            </button>
          )}
        </SetupRow>
      </Glass>
    </div>
  );
}

/**
 * The few settings that matter on day one, already set the way most people want them. Each
 * applies as you change it; Settings has every one of them later.
 */
export function Setup() {
  const api = useApi();
  const prefs = usePrefs();
  const self = useApp((st) => st.self?.name ?? '');
  const policy = useApp((st) => st.policy);
  const core = useApp((st) => st.prefs);
  const [name, setName] = useState(self);
  // What's typed is saved on Return, on leaving the field, and when the step goes (⌘] doesn't blur).
  const typed = useRef({ name, self });
  typed.current = { name, self };
  const saveName = (): void => {
    const next = typed.current.name.trim();
    if (next && next !== typed.current.self) void api.session.rename(next);
  };
  useEffect(() => saveName, []);
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="A few good defaults." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        Already set to what works best for most people. Change anything now, or later in Settings.
      </Rise>
      <Glass radius={16} width="100%" className={s.rows}>
        <SetupRow index={0} label="Your name" detail="What friends see when you work together.">
          <input className={s.input} aria-label="Your name" value={name} placeholder="Your name" maxLength={64} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && saveName()} />
        </SetupRow>
        <SetupRow index={1} label="When a friend asks your agent" detail={policy === 'ask' ? 'Recommended: you see and approve every request.' : policy === 'auto' ? 'Requests from friends run without asking.' : 'Only you can use your agent.'}>
          <Choice
            label="Friends' requests"
            value={policy}
            onChange={(v) => void api.session.setClaudeSharing(v)}
            options={[
              { value: 'ask', label: 'Ask Me' },
              { value: 'auto', label: 'Allow' },
              { value: 'deny', label: 'Private' },
            ]}
          />
        </SetupRow>
        <SetupRow index={2} label="Tell me when my agent needs me" detail={core.notify.onlyAway ? 'When a run finishes or waits for you, while you’re in another app.' : 'When a run finishes or waits for you.'}>
          <Switch label="Notifications" on={core.notify.desktop} onChange={(v) => void api.session.setPrefs({ notify: { ...core.notify, desktop: v, ...(v ? { onlyAway: true } : {}) } })} />
        </SetupRow>
        <SetupRow index={3} label="Ask before my agent runs commands" detail="Off lets your agent work on its own in your worktrees. Secrets stay blocked either way.">
          <Switch label="Ask before running commands" on={core.selfApproval === 'ask'} onChange={(v) => void api.session.setPrefs({ selfApproval: v ? 'ask' : 'never' })} />
        </SetupRow>
        {/* Your agent is picked on its own step, right after the welcome (AgentsStep.tsx). */}
        <SetupRow index={4} label="Send messages with" detail={prefs.sendWith === 'enter' ? 'Shift-Return makes a new line.' : 'Return makes a new line.'}>
          <Choice
            label="Send with"
            value={prefs.sendWith}
            onChange={(v) => setPrefs({ sendWith: v })}
            options={[
              { value: 'enter', label: returnName() },
              { value: 'cmd-enter', label: cmdReturn(' ') },
            ]}
          />
        </SetupRow>
      </Glass>
    </div>
  );
}
