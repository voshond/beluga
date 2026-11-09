import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';

/**
 * What kind of computer this is (BLG-782), so it gets a fitting icon and name with nothing to set:
 * a cloud server (AWS, Google Cloud, Azure, DigitalOcean, Hetzner), a Mac by model, a Raspberry Pi,
 * a Docker or Podman container, or a plain Linux box. Worked out once at start from what the
 * computer says about itself (DMI on Linux, the device tree, sysctl on a Mac), through readers
 * passed in so it's tested from recorded values.
 *
 * Cloud metadata is only ever a confirmation and the way to learn the region: a fixed link-local
 * address, a 300 ms limit for the whole lookup, each cloud's own header (AWS's IMDSv2 token,
 * Google's Metadata-Flavor, Azure's Metadata), nothing from anyone in the URL. It's never required:
 * without it the kind stands, without a region.
 */

import type { LinuxDistro, MachineKind } from '../shared/machine-kinds.js';

export { LINUX_DISTROS, MACHINE_KINDS, type LinuxDistro, type MachineKind } from '../shared/machine-kinds.js';
export type CloudKind = Extract<MachineKind, 'aws' | 'gcp' | 'azure' | 'digitalocean' | 'hetzner'>;

export interface KindFound {
  readonly kind: MachineKind;
  /** The cloud region ("eu-west-1", "westeurope"), when its metadata said. */
  readonly region?: string;
  /** On Linux, which distribution and its version ("24.04"), from os-release. */
  readonly distro?: LinuxDistro;
  readonly distroVersion?: string;
}

export interface KindReaders {
  readonly platform: NodeJS.Platform;
  /** A file's text, trimmed; undefined when it isn't there or can't be read. */
  readonly read: (file: string) => Promise<string | undefined>;
  readonly exists: (file: string) => Promise<boolean>;
  /** `sysctl -n <name>` on a Mac. */
  readonly sysctl: (name: string) => Promise<string | undefined>;
  /** Its environment variables: hosts like Codespaces, Fly.io, Railway and Render say so there. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** A request to the metadata address; left out, no metadata is asked. */
  readonly fetch?: (url: string, init: { method?: 'GET' | 'PUT'; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;
}

/** The whole metadata lookup, at most. */
export const METADATA_TIMEOUT_MS = 300;
const METADATA = 'http://169.254.169.254';
/** What Azure puts in every VM's chassis asset tag. */
const AZURE_CHASSIS_TAG = '7783-7084-3265-9085-8269-3286-77';

/** Apple Silicon models by their identifier ("Mac14,3"); the older ones carry their family in the name. */
const MAC_MODELS: Record<string, MachineKind> = {
  ...Object.fromEntries(['Mac14,3', 'Mac14,12', 'Mac16,10', 'Mac16,11'].map((m) => [m, 'mac-mini'])),
  ...Object.fromEntries(['Mac13,1', 'Mac13,2', 'Mac14,13', 'Mac14,14', 'Mac15,14', 'Mac16,9'].map((m) => [m, 'mac-studio'])),
  ...Object.fromEntries(['Mac15,4', 'Mac15,5', 'Mac16,2', 'Mac16,3'].map((m) => [m, 'imac'])),
  ...Object.fromEntries(
    ['Mac14,2', 'Mac14,15', 'Mac14,5', 'Mac14,6', 'Mac14,7', 'Mac14,9', 'Mac14,10', 'Mac15,3', 'Mac15,6', 'Mac15,7', 'Mac15,8', 'Mac15,9', 'Mac15,10', 'Mac15,11', 'Mac15,12', 'Mac15,13', 'Mac16,1', 'Mac16,5', 'Mac16,6', 'Mac16,7', 'Mac16,8', 'Mac16,12', 'Mac16,13'].map((m) => [m, 'macbook']),
  ),
};

/** A Mac's kind from `hw.model`. */
export function macKind(model: string | undefined): MachineKind {
  const m = (model ?? '').trim();
  if (MAC_MODELS[m]) return MAC_MODELS[m]!;
  if (/^Macmini/i.test(m)) return 'mac-mini';
  if (/^MacBook/i.test(m)) return 'macbook';
  if (/^MacStudio/i.test(m)) return 'mac-studio';
  if (/^iMac/i.test(m)) return 'imac';
  return 'mac';
}

/** A cloud from DMI: who made the (virtual) machine, its product, its asset tags. */
export function cloudFromDmi(dmi: { vendor?: string; product?: string; board?: string; chassis?: string }): CloudKind | undefined {
  const vendor = dmi.vendor ?? '';
  const product = dmi.product ?? '';
  if (/^Amazon EC2$/i.test(vendor) || /^EC2\b/.test(product) || /^i-[0-9a-f]{8,17}$/.test(dmi.board ?? '')) return 'aws';
  if (/^Google$/i.test(vendor) || /^Google Compute Engine$/i.test(product)) return 'gcp';
  if (/^Microsoft Corporation$/i.test(vendor) && /^Virtual Machine$/i.test(product) && dmi.chassis === AZURE_CHASSIS_TAG) return 'azure';
  if (/^DigitalOcean$/i.test(vendor)) return 'digitalocean';
  if (/^Hetzner$/i.test(vendor)) return 'hetzner';
  return undefined;
}

/** Any other cloud or virtual machine from DMI (no region for these): the vendor's own words, recorded on each. */
export function otherFromDmi(dmi: { vendor?: string; product?: string; chassis?: string }): MachineKind | undefined {
  const vendor = dmi.vendor ?? '';
  const product = dmi.product ?? '';
  // VirtualBox before Oracle: since 7.0 its vendor is Oracle too.
  if (/^VirtualBox$/i.test(product) || /^innotek/i.test(vendor)) return 'virtualbox';
  if (/^Oracle Corporation$/i.test(vendor) && /^OracleCloud\.com$/i.test(dmi.chassis ?? '')) return 'oracle';
  if (/^(Linode|Akamai)/i.test(vendor)) return 'linode';
  if (/^Vultr$/i.test(vendor)) return 'vultr';
  if (/^Scaleway$/i.test(vendor)) return 'scaleway';
  if (/^OVH/i.test(vendor)) return 'ovh';
  if (/^Alibaba Cloud$/i.test(vendor) || /^Alibaba Cloud ECS$/i.test(product)) return 'alibaba';
  if (/^UpCloud$/i.test(vendor)) return 'upcloud';
  if (/^Exoscale$/i.test(vendor)) return 'exoscale';
  if (/^VMware/i.test(vendor) || /^VMware/i.test(product)) return 'vmware';
  if (/^Parallels/i.test(vendor)) return 'parallels';
  if (/^Microsoft Corporation$/i.test(vendor) && /^Virtual Machine$/i.test(product)) return 'hyperv';
  if (/^Apple Inc\.?$/i.test(vendor) && /Virtuali[sz]ation/i.test(product)) return 'apple-vm';
  // QEMU and KVM: Proxmox, libvirt, UTM's QEMU machines.
  if (/^QEMU$/i.test(vendor) || /\bKVM\b/.test(product)) return 'qemu';
  return undefined;
}

/** A host that says what it is in its environment (it also runs in a container: the host wins). */
function hostFromEnv(env: Readonly<Record<string, string | undefined>> | undefined): MachineKind | undefined {
  if (!env) return undefined;
  if (env['CODESPACES'] === 'true') return 'codespaces';
  if (env['FLY_APP_NAME'] || env['FLY_MACHINE_ID']) return 'fly';
  if (env['RAILWAY_ENVIRONMENT'] || env['RAILWAY_PROJECT_ID']) return 'railway';
  if (env['RENDER'] === 'true' || env['RENDER_SERVICE_ID']) return 'render';
  if (env['KUBERNETES_SERVICE_HOST']) return 'kubernetes';
  return undefined;
}

/** A container this runs in, from its marker files and PID 1's cgroup (a Kubernetes pod says kubepods). */
async function containerKind(r: KindReaders): Promise<'docker' | 'podman' | 'kubernetes' | undefined> {
  const cgroup = (await r.read('/proc/1/cgroup')) ?? '';
  if (/kubepods/.test(cgroup)) return 'kubernetes';
  if (await r.exists('/run/.containerenv')) return 'podman';
  if (await r.exists('/.dockerenv')) return 'docker';
  if (/libpod/.test(cgroup)) return 'podman';
  if (/docker|containerd/.test(cgroup)) return 'docker';
  return undefined;
}

/** What this computer is, from what it says about itself (no network). */
export async function localKind(r: KindReaders): Promise<MachineKind> {
  if (r.platform === 'darwin') return macKind(await r.sysctl('hw.model'));
  if (r.platform === 'win32') return 'windows';
  const host = hostFromEnv(r.env);
  if (host) return host;
  const container = await containerKind(r);
  if (container) return container;
  // Linux inside Windows (WSL 1 and 2 both say so in the kernel's version).
  if (/microsoft|WSL/i.test((await r.read('/proc/version')) ?? '')) return 'wsl';
  const model = await r.read('/proc/device-tree/model');
  if (model && /Raspberry Pi/i.test(model)) return 'raspberry-pi';
  const dmi = '/sys/class/dmi/id';
  const [vendor, product, board, chassis] = await Promise.all(['sys_vendor', 'product_name', 'board_asset_tag', 'chassis_asset_tag'].map((f) => r.read(`${dmi}/${f}`)));
  const said = { ...(vendor ? { vendor } : {}), ...(product ? { product } : {}), ...(board ? { board } : {}), ...(chassis ? { chassis } : {}) };
  return cloudFromDmi(said) ?? otherFromDmi(said) ?? 'linux';
}

/** A region as clouds name them: letters, digits and dashes. */
const cleanRegion = (text: string | undefined): string | undefined => {
  const t = (text ?? '').trim();
  return /^[a-z0-9-]{2,40}$/i.test(t) ? t : undefined;
};

/**
 * The cloud's region from its metadata, within `timeoutMs` in all; undefined when it doesn't answer
 * (or isn't that cloud). Never throws.
 */
export async function cloudRegion(kind: CloudKind, fetch: NonNullable<KindReaders['fetch']>, timeoutMs = METADATA_TIMEOUT_MS): Promise<string | undefined> {
  const signal = AbortSignal.timeout(timeoutMs);
  const get = async (url: string, headers: Record<string, string> = {}, method: 'GET' | 'PUT' = 'GET'): Promise<string | undefined> => {
    const res = await fetch(url, { method, headers, signal });
    return res.ok ? (await res.text()).trim() : undefined;
  };
  try {
    switch (kind) {
      case 'aws': {
        const token = await get(`${METADATA}/latest/api/token`, { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, 'PUT');
        return token ? cleanRegion(await get(`${METADATA}/latest/meta-data/placement/region`, { 'X-aws-ec2-metadata-token': token })) : undefined;
      }
      case 'gcp': {
        // projects/123/zones/europe-west1-b → europe-west1
        const zone = (await get(`${METADATA}/computeMetadata/v1/instance/zone`, { 'Metadata-Flavor': 'Google' }))?.split('/').pop();
        return cleanRegion(zone?.replace(/-[a-z]$/, ''));
      }
      case 'azure':
        return cleanRegion(await get(`${METADATA}/metadata/instance/compute/location?api-version=2021-02-01&format=text`, { Metadata: 'true' }));
      case 'digitalocean':
        return cleanRegion(await get(`${METADATA}/metadata/v1/region`));
      case 'hetzner':
        return cleanRegion(await get(`${METADATA}/hetzner/v1/metadata/region`));
    }
  } catch {
    return undefined;
  }
}

const CLOUDS: readonly MachineKind[] = ['aws', 'gcp', 'azure', 'digitalocean', 'hetzner'];

/** os-release's ID (or one of ID_LIKE) → the distribution. */
const OS_IDS: Readonly<Record<string, LinuxDistro>> = {
  ubuntu: 'ubuntu',
  debian: 'debian',
  fedora: 'fedora',
  arch: 'arch',
  archarm: 'arch',
  alpine: 'alpine',
  centos: 'centos',
  rhel: 'rhel',
  rocky: 'rocky',
  almalinux: 'alma',
  opensuse: 'opensuse',
  'opensuse-leap': 'opensuse',
  'opensuse-tumbleweed': 'opensuse',
  sles: 'opensuse',
  suse: 'opensuse',
  nixos: 'nixos',
  linuxmint: 'mint',
  manjaro: 'manjaro',
  pop: 'pop',
  gentoo: 'gentoo',
  kali: 'kali',
};

/**
 * Which Linux it is, from os-release's text: its ID first, else the first of ID_LIKE we know (a
 * derivative shows its parent's mark), with VERSION_ID when it's a plain version.
 */
export function distroFromOsRelease(text: string | undefined): { readonly distro: LinuxDistro; readonly version?: string } | undefined {
  if (!text) return undefined;
  const field = (key: string): string | undefined => {
    const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
    return m?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
  };
  const ids = [field('ID'), ...(field('ID_LIKE')?.split(/\s+/) ?? [])].filter((id): id is string => !!id);
  const distro = ids.map((id) => OS_IDS[id]).find((d): d is LinuxDistro => !!d);
  if (!distro) return undefined;
  const version = field('VERSION_ID');
  return { distro, ...(version && /^[a-z0-9._-]{1,16}$/.test(version) ? { version } : {}) };
}

/** The kind, on Linux its distribution, and for a cloud server its region when the metadata says so in time. */
export async function detectKind(r: KindReaders, timeoutMs = METADATA_TIMEOUT_MS): Promise<KindFound> {
  const kind = await localKind(r).catch((): MachineKind => (r.platform === 'darwin' ? 'mac' : r.platform === 'win32' ? 'windows' : 'linux'));
  const os = r.platform === 'linux' ? distroFromOsRelease((await r.read('/etc/os-release')) ?? (await r.read('/usr/lib/os-release'))) : undefined;
  const distro = os ? { distro: os.distro, ...(os.version ? { distroVersion: os.version } : {}) } : {};
  if (!CLOUDS.includes(kind) || !r.fetch) return { kind, ...distro };
  const region = await cloudRegion(kind as CloudKind, r.fetch, timeoutMs);
  return { kind, ...(region ? { region } : {}), ...distro };
}

/** The real readers, on this computer. */
export const realKindReaders: KindReaders = {
  platform: process.platform,
  read: (file) => readFile(file, 'utf8').then((t) => t.replace(/\0/g, '').trim() || undefined, () => undefined),
  exists: (file) => access(file).then(() => true, () => false),
  env: process.env,
  sysctl: (name) =>
    new Promise((resolve) => {
      execFile('sysctl', ['-n', name], { timeout: 2_000 }, (err, out) => resolve(err ? undefined : String(out).trim() || undefined));
    }),
  fetch: (url, init) => fetch(url, init),
};
