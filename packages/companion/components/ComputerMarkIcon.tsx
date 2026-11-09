import type { ComponentType } from 'react';
import { Platform } from 'react-native';
import Svg, { Path, SvgXml } from 'react-native-svg';
import { LINUX_DISTROS, type LinuxDistro, MACHINE_KINDS, type MachineKind } from '../../../src/shared/machine-kinds';
import { machineLook } from '../../../src/machines/look';
import { COMPUTER_BRANDS, COMPUTER_GLYPHS, type ComputerBrandMark } from '../../../src/shared/computer-marks';
import type { MachineIcon } from '../../../src/shared/settings-schema';
import type { PhoneComputer } from '../lib/link/protocol';
import { color as palette } from '../lib/theme';
import type { IconLike } from './AgentMark';

/**
 * A computer of yours, drawn as the Mac draws it (src/machines/look.ts): its maker's logo (AWS,
 * Ubuntu, Hetzner…) in the brand's colour, AWS's and Azure's in full colour, or the app's own glyph
 * (a Mac mini, a PC, a virtual machine) in the ink it's given. The same data as the Mac's
 * (src/shared/computer-marks.ts).
 */

const HIDDEN = Platform.OS === 'web' ? { 'aria-hidden': true } : { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const };
const KINDS = new Set<string>(MACHINE_KINDS);
const DISTROS = new Set<string>(LINUX_DISTROS);

/** What the Mac said of it, as the shared look reads it (a kind or distribution this phone doesn't know is left out). */
function lookOf(c: Pick<PhoneComputer, 'icon' | 'kind' | 'distro' | 'platform'>) {
  return machineLook({
    platform: c.platform,
    ...(c.icon ? { icon: c.icon as MachineIcon } : {}),
    ...(c.kind && KINDS.has(c.kind) ? { kind: c.kind as MachineKind } : {}),
    ...(c.distro && DISTROS.has(c.distro) ? { distro: c.distro as LinuxDistro } : {}),
  });
}

function Mark({ look, size, ink }: { readonly look: ReturnType<typeof lookOf>; readonly size: number; readonly ink: string }) {
  const brand: ComputerBrandMark | undefined = look.brand ? COMPUTER_BRANDS[look.brand] : undefined;
  if (brand?.svg) return <SvgXml xml={brand.svg} width={size} height={size} {...HIDDEN} />;
  if (brand?.d) {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" {...HIDDEN}>
        <Path d={brand.d} fill={brand.color ?? ink} />
      </Svg>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" {...HIDDEN}>
      <Path d={COMPUTER_GLYPHS[look.glyph]} stroke={ink} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

const ICONS = new Map<string, IconLike>();

/** A computer's mark as an icon slot's component (IconBadge, Options rows), made once per look. */
export function computerMarkIcon(c: Pick<PhoneComputer, 'icon' | 'kind' | 'distro' | 'platform'>): IconLike {
  const look = lookOf(c);
  const key = `${look.brand ?? ''}:${look.glyph}`;
  let Icon = ICONS.get(key);
  if (!Icon) {
    const Made: ComponentType<{ color?: string; size?: number }> = ({ color, size }) => <Mark look={look} size={size ?? 16} ink={color ?? palette.text} />;
    Made.displayName = `ComputerMark(${key})`;
    Icon = Made;
    ICONS.set(key, Icon);
  }
  return Icon;
}
