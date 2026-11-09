import type { MachineView } from '@beluga/machines/machines.js';
import type { ReactNode } from 'react';
import { Icon } from '../components/Icon.js';
import { BRANDS } from './brands.js';
import { machineLook } from './model.js';
import c from './machines.module.css';
import { maskOf } from './mask.js';

/**
 * A computer's mark: a brand's own, or a glyph from the app's set. A full-colour mark (AWS, Azure)
 * is the owner's file as an image.
 */
export function MachineMark({ machine, size = 18 }: { machine: Pick<MachineView, 'icon' | 'kind' | 'platform' | 'distro'>; size?: number }) {
  const look = machineLook(machine);
  const brand = look.brand ? BRANDS[look.brand] : undefined;
  const box = size === 18 ? undefined : { width: size + 2, height: size + 2 };
  return (
    <span className={c.mark} title={brand?.title} style={size === 18 ? undefined : { width: size + 4, height: size + 4, marginTop: 0 }}>
      {brand && 'url' in brand ? (
        <span className={c.brand} role="img" aria-label={brand.title} data-deep={deep(brand.color) || undefined} style={{ background: brand.color, maskImage: maskOf(brand.url), WebkitMaskImage: maskOf(brand.url), ...box }} />
      ) : brand ? (
        <img className={c.brandFull} src={brand.full} alt={brand.title} draggable={false} style={box} />
      ) : (
        <Icon name={look.glyph} size={size} />
      )}
    </span>
  );
}


/** A brand colour too dark to see on a dark window (CentOS's navy, Gentoo's purple): lifted there in CSS. */
function deep(color: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 125;
}

/** A place's mark in a menu (Move To ▸, Continue On ▸): the computer's own, or a laptop for This Mac. */
export function placeMark(machine?: Pick<MachineView, 'icon' | 'kind' | 'platform' | 'distro'>): ReactNode {
  return machine ? <MachineMark machine={machine} size={13} /> : <Icon name="laptop" size={13} />;
}
