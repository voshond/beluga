import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon.js';
import { Avatar, cx } from '../components/ui.js';
import { reducedMotion } from '../lib/reduced-motion.js';
import { useCallEngine } from './use-call.js';
import c from './call.module.css';

/**
 * Someone in a call: their picture with a soft ring that breathes with their voice (BLG-706). The
 * ring reads the voice's level on every frame straight from the engine, so it follows each
 * syllable without React drawing anything; with reduced motion it only shows, steady, while they talk.
 */
export function CallAvatar({ peerId, name, size = 28, speaking, muted, sharing }: { peerId: string; name: string; size?: number; speaking: boolean; muted?: boolean; sharing?: boolean }) {
  const engine = useCallEngine();
  const ring = useRef<HTMLSpanElement>(null);
  const reduced = reducedMotion();
  useEffect(() => {
    const el = ring.current;
    if (!el || reduced) return;
    let frame = 0;
    let shown = 0;
    const draw = (): void => {
      const level = muted ? 0 : engine.level(peerId);
      shown += (level - shown) * 0.35;
      el.style.setProperty('--voice', String(Math.min(1, shown * 3.2)));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [engine, peerId, muted, reduced]);
  return (
    <span className={cx(c.avatar, speaking && !muted && c.speaking)} style={{ width: size, height: size }}>
      <span ref={ring} className={c.voiceRing} aria-hidden="true" />
      <Avatar name={name} id={peerId} size={size} />
      {muted ? (
        <span className={c.badge} title={`${name} is muted`}>
          <Icon name="micOff" size={9} />
        </span>
      ) : sharing ? (
        <span className={cx(c.badge, c.badgeShare)} title={`${name} is sharing`}>
          <Icon name="screenShare" size={9} />
        </span>
      ) : null}
    </span>
  );
}
