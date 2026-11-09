/**
 * The kinds of computer Beluga tells apart (BLG-782) and the Linux distributions with their own
 * mark. Browser-safe, so the phone draws a computer's mark from the same lists the daemon detects
 * with (src/machines/kind.ts finds which one this computer is).
 */

export const MACHINE_KINDS = [
  // Clouds (the first five also say their region).
  'aws',
  'gcp',
  'azure',
  'digitalocean',
  'hetzner',
  'oracle',
  'linode',
  'vultr',
  'scaleway',
  'ovh',
  'alibaba',
  'upcloud',
  'exoscale',
  // Where an app is hosted, told by the variables it sets.
  'codespaces',
  'fly',
  'railway',
  'render',
  'kubernetes',
  // Macs by model.
  'mac-mini',
  'macbook',
  'mac-studio',
  'imac',
  'mac',
  // Boards, containers, virtual machines.
  'raspberry-pi',
  'docker',
  'podman',
  'wsl',
  'vmware',
  'qemu',
  'virtualbox',
  'parallels',
  'hyperv',
  'apple-vm',
  'linux',
  'windows',
] as const;
export type MachineKind = (typeof MACHINE_KINDS)[number];

/** The Linux distributions known by their own mark; any other Linux is plain Linux (Tux). */
export const LINUX_DISTROS = ['ubuntu', 'debian', 'fedora', 'arch', 'alpine', 'centos', 'rhel', 'rocky', 'alma', 'opensuse', 'nixos', 'mint', 'manjaro', 'pop', 'gentoo', 'kali'] as const;
export type LinuxDistro = (typeof LINUX_DISTROS)[number];
