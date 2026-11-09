import type { ComputerBrand, ComputerGlyph } from '../shared/computer-marks.js';
import type { MachineIcon } from '../shared/settings-schema.js';
import type { LinuxDistro, MachineKind } from '../shared/machine-kinds.js';

/**
 * Which mark a computer of yours shows, the same on the Mac and the phone: the icon kept on it,
 * else its Linux distribution's (a plain Linux box, WSL), else its kind's own: a maker's logo where
 * one ships (src/shared/computer-marks.ts, THIRD_PARTY_ICONS.md), else one of the app's glyphs.
 * Browser-safe.
 */

export type Brand = ComputerBrand;

/**
 * A kind's own look: a brand mark where one ships (THIRD_PARTY_ICONS.md), else a glyph of the app's
 * own. Apple hardware and Windows PCs get the app's own drawing of each (a Mac mini, a Mac Studio,
 * an iMac, a MacBook, a PC), never Apple's or Microsoft's marks, which they don't let others use.
 */
const KIND_LOOK: Record<MachineKind, { readonly brand?: Brand; readonly glyph: ComputerGlyph }> = {
  aws: { brand: 'aws', glyph: 'cloud' },
  gcp: { brand: 'googlecloud', glyph: 'cloud' },
  azure: { brand: 'azure', glyph: 'cloud' },
  digitalocean: { brand: 'digitalocean', glyph: 'cloud' },
  hetzner: { brand: 'hetzner', glyph: 'server' },
  oracle: { glyph: 'cloud' },
  linode: { brand: 'akamai', glyph: 'cloud' },
  vultr: { brand: 'vultr', glyph: 'cloud' },
  scaleway: { brand: 'scaleway', glyph: 'cloud' },
  ovh: { brand: 'ovh', glyph: 'cloud' },
  alibaba: { brand: 'alibabacloud', glyph: 'cloud' },
  upcloud: { brand: 'upcloud', glyph: 'cloud' },
  exoscale: { brand: 'exoscale', glyph: 'cloud' },
  codespaces: { brand: 'github', glyph: 'cloud' },
  fly: { brand: 'flydotio', glyph: 'cloud' },
  railway: { brand: 'railway', glyph: 'cloud' },
  render: { brand: 'render', glyph: 'cloud' },
  kubernetes: { brand: 'kubernetes', glyph: 'box' },
  'mac-mini': { glyph: 'macMini' },
  macbook: { glyph: 'laptop' },
  'mac-studio': { glyph: 'macStudio' },
  imac: { glyph: 'imac' },
  mac: { glyph: 'desktop' },
  'raspberry-pi': { brand: 'raspberrypi', glyph: 'chip' },
  docker: { brand: 'docker', glyph: 'box' },
  podman: { brand: 'podman', glyph: 'box' },
  // Oracle's own marks (Oracle Cloud, VirtualBox), Parallels', Microsoft's and Apple's aren't ours to use: the app's own.
  wsl: { glyph: 'pc' },
  vmware: { brand: 'vmware', glyph: 'vm' },
  qemu: { brand: 'qemu', glyph: 'vm' },
  virtualbox: { glyph: 'vm' },
  parallels: { glyph: 'vm' },
  hyperv: { glyph: 'vm' },
  'apple-vm': { glyph: 'vm' },
  linux: { brand: 'linux', glyph: 'server' },
  windows: { glyph: 'pc' },
};

/** A Linux distribution's own mark, shown in place of Tux. */
const DISTRO_BRAND: Record<LinuxDistro, Brand> = {
  ubuntu: 'ubuntu',
  debian: 'debian',
  fedora: 'fedora',
  arch: 'archlinux',
  alpine: 'alpinelinux',
  centos: 'centos',
  rhel: 'redhat',
  rocky: 'rockylinux',
  alma: 'almalinux',
  opensuse: 'opensuse',
  nixos: 'nixos',
  mint: 'linuxmint',
  manjaro: 'manjaro',
  pop: 'popos',
  gentoo: 'gentoo',
  kali: 'kalilinux',
};

/** What to draw: a brand mark, or a glyph from the app's own set. */
export function machineLook(m: { readonly icon?: MachineIcon; readonly kind?: MachineKind; readonly platform: string; readonly distro?: LinuxDistro }): { readonly brand?: Brand; readonly glyph: ComputerGlyph } {
  if (m.icon && m.icon !== 'auto') return { glyph: m.icon };
  // A plain Linux box (or one whose kind isn't known yet) shows its distribution's mark.
  if (m.distro && (!m.kind || m.kind === 'linux' || m.kind === 'wsl')) return { brand: DISTRO_BRAND[m.distro], glyph: 'server' };
  if (m.kind) return KIND_LOOK[m.kind];
  return m.platform === 'macos' ? { glyph: 'desktop' } : m.platform === 'windows' ? { glyph: 'pc' } : { brand: 'linux', glyph: 'server' };
}
