import { describe, expect, it } from 'vitest';
import { type KindReaders, METADATA_TIMEOUT_MS, cloudRegion, detectKind, distroFromOsRelease, localKind } from '../src/machines/kind.js';

/** What kind of computer it is (BLG-782), from values recorded on real machines. */

type Files = Record<string, string>;

function readers(platform: NodeJS.Platform, files: Files = {}, sysctl: Record<string, string> = {}, fetch?: KindReaders['fetch'], env?: Record<string, string>): KindReaders {
  return {
    platform,
    ...(env ? { env } : {}),
    read: async (f) => files[f]?.trim() || undefined,
    exists: async (f) => f in files,
    sysctl: async (n) => sysctl[n],
    ...(fetch ? { fetch } : {}),
  };
}

const dmi = (vendor: string, product: string, extra: { board?: string; chassis?: string } = {}): Files => ({
  '/sys/class/dmi/id/sys_vendor': `${vendor}\n`,
  '/sys/class/dmi/id/product_name': `${product}\n`,
  ...(extra.board ? { '/sys/class/dmi/id/board_asset_tag': `${extra.board}\n` } : {}),
  ...(extra.chassis ? { '/sys/class/dmi/id/chassis_asset_tag': `${extra.chassis}\n` } : {}),
});

const LINUX: Array<[string, Files, string]> = [
  ['an EC2 Nitro instance', dmi('Amazon EC2', 'm6i.large', { board: 'i-0abc1234def567890' }), 'aws'],
  ['an EC2 instance known by its asset tag alone', dmi('', '', { board: 'i-0abc1234def567890' }), 'aws'],
  ['Google Compute Engine', dmi('Google', 'Google Compute Engine'), 'gcp'],
  ['an Azure VM', dmi('Microsoft Corporation', 'Virtual Machine', { chassis: '7783-7084-3265-9085-8269-3286-77' }), 'azure'],
  ['Hyper-V on a desk (no Azure tag)', dmi('Microsoft Corporation', 'Virtual Machine', { chassis: 'None' }), 'hyperv'],
  ['a DigitalOcean droplet', dmi('DigitalOcean', 'Droplet'), 'digitalocean'],
  ['a Hetzner cloud server', dmi('Hetzner', 'vServer'), 'hetzner'],
  ['a Raspberry Pi 5', { '/proc/device-tree/model': 'Raspberry Pi 5 Model B Rev 1.0\0' }, 'raspberry-pi'],
  ['a Docker container', { '/.dockerenv': '' }, 'docker'],
  ['a Docker container on EC2 (the container is what Beluga runs in)', { '/.dockerenv': '', ...dmi('Amazon EC2', 'm6i.large') }, 'docker'],
  ['a Kubernetes pod known by its cgroup', { '/proc/1/cgroup': '0::/system.slice/containerd.service/kubepods-besteffort' }, 'kubernetes'],
  ['a container known by its cgroup', { '/proc/1/cgroup': '0::/system.slice/containerd.service/cri-containerd-3f2a.scope' }, 'docker'],
  ['an Oracle Cloud instance', dmi('Oracle Corporation', 'Standard PC (i440FX + PIIX, 1996)', { chassis: 'OracleCloud.com' }), 'oracle'],
  ['VirtualBox 7 (Oracle as vendor, not Oracle Cloud)', dmi('Oracle Corporation', 'VirtualBox'), 'virtualbox'],
  ['older VirtualBox', dmi('innotek GmbH', 'VirtualBox'), 'virtualbox'],
  ['a Linode', dmi('Linode', 'Compute Instance'), 'linode'],
  ['a Vultr server', dmi('Vultr', 'VC2'), 'vultr'],
  ['a Scaleway instance', dmi('Scaleway', 'SCW-DEV1-S'), 'scaleway'],
  ['an OVH VPS', dmi('OVH SAS', 'vps-2024'), 'ovh'],
  ['an Alibaba Cloud ECS', dmi('Alibaba Cloud', 'Alibaba Cloud ECS'), 'alibaba'],
  ['an UpCloud server', dmi('UpCloud', 'Cloud Server'), 'upcloud'],
  ['an Exoscale instance', dmi('Exoscale', 'Compute'), 'exoscale'],
  ['a VMware VM', dmi('VMware, Inc.', 'VMware Virtual Platform'), 'vmware'],
  ['a Parallels VM', dmi('Parallels International GmbH.', 'Parallels ARM Virtual Machine'), 'parallels'],
  ['Proxmox (QEMU)', dmi('QEMU', 'Standard PC (Q35 + ICH9, 2009)'), 'qemu'],
  ['KVM by Red Hat', dmi('Red Hat', 'KVM'), 'qemu'],
  ['Apple Virtualization', dmi('Apple Inc.', 'Apple Virtualization Generic Platform'), 'apple-vm'],
  ['WSL 2', { '/proc/version': 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@941d701f84f1)' }, 'wsl'],
  ['a Docker container in WSL (the container is what Beluga runs in)', { '/.dockerenv': '', '/proc/version': 'Linux version 5.15.153.1-microsoft-standard-WSL2' }, 'docker'],
  ['a Podman container', { '/run/.containerenv': '' }, 'podman'],
  ['a Podman container known by its cgroup', { '/proc/1/cgroup': '0::/machine.slice/libpod-3f2a.scope' }, 'podman'],
  ['a plain Linux box', dmi('Dell Inc.', 'OptiPlex 7090'), 'linux'],
  ['a Linux box that says nothing', {}, 'linux'],
];

const MACS: Array<[string, string]> = [
  ['Macmini9,1', 'mac-mini'],
  ['Mac14,3', 'mac-mini'],
  ['Mac16,10', 'mac-mini'],
  ['MacBookPro18,3', 'macbook'],
  ['MacBookAir10,1', 'macbook'],
  ['Mac14,2', 'macbook'],
  ['Mac15,3', 'macbook'],
  ['Mac13,1', 'mac-studio'],
  ['Mac14,13', 'mac-studio'],
  ['iMac21,1', 'imac'],
  ['Mac15,4', 'imac'],
  ['MacPro7,1', 'mac'],
  ['Mac99,9', 'mac'],
];

describe('what kind of computer', () => {
  it.each(LINUX)('Linux: %s', async (_what, files, kind) => {
    expect(await localKind(readers('linux', files))).toBe(kind);
  });

  it.each(MACS)('a Mac whose hw.model is %s', async (model, kind) => {
    expect(await localKind(readers('darwin', {}, { 'hw.model': model }))).toBe(kind);
  });

  it('Windows is Windows; a Mac that won’t say is a Mac', async () => {
    expect(await localKind(readers('win32'))).toBe('windows');
    expect(await localKind(readers('darwin'))).toBe('mac');
  });
});

/** A metadata service that answers as `cloud` does (checking its header), after `delayMs`. */
function metadata(answers: Record<string, { body: string; header?: [string, string]; method?: string }>, delayMs = 0): { fetch: NonNullable<KindReaders['fetch']>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        asked.push(`${init.method ?? 'GET'} ${url}`);
        const timer = setTimeout(() => {
          const a = answers[url];
          const ok = Boolean(a) && (!a!.header || init.headers[a!.header[0]] === a!.header[1]) && (!a!.method || a!.method === (init.method ?? 'GET'));
          resolve({ ok, text: async () => (ok ? a!.body : '') });
        }, delayMs);
        init.signal.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true });
      }),
  };
}

describe('the cloud’s region, from its metadata', () => {
  it('AWS asks for an IMDSv2 token first, then the region with it', async () => {
    const m = metadata({
      'http://169.254.169.254/latest/api/token': { body: 'TOKEN', header: ['X-aws-ec2-metadata-token-ttl-seconds', '60'], method: 'PUT' },
      'http://169.254.169.254/latest/meta-data/placement/region': { body: 'eu-west-1', header: ['X-aws-ec2-metadata-token', 'TOKEN'] },
    });
    expect(await detectKind(readers('linux', dmi('Amazon EC2', 'm6i.large'), {}, m.fetch))).toEqual({ kind: 'aws', region: 'eu-west-1' });
    expect(m.asked).toEqual(['PUT http://169.254.169.254/latest/api/token', 'GET http://169.254.169.254/latest/meta-data/placement/region']);
  });

  it('Google with Metadata-Flavor (the zone made a region), Azure with Metadata, DigitalOcean and Hetzner as they are', async () => {
    const gcp = metadata({ 'http://169.254.169.254/computeMetadata/v1/instance/zone': { body: 'projects/1234/zones/europe-west1-b', header: ['Metadata-Flavor', 'Google'] } });
    expect(await cloudRegion('gcp', gcp.fetch)).toBe('europe-west1');
    const azure = metadata({ 'http://169.254.169.254/metadata/instance/compute/location?api-version=2021-02-01&format=text': { body: 'westeurope', header: ['Metadata', 'true'] } });
    expect(await cloudRegion('azure', azure.fetch)).toBe('westeurope');
    expect(await cloudRegion('digitalocean', metadata({ 'http://169.254.169.254/metadata/v1/region': { body: 'nyc3' } }).fetch)).toBe('nyc3');
    expect(await cloudRegion('hetzner', metadata({ 'http://169.254.169.254/hetzner/v1/metadata/region': { body: 'eu-central' } }).fetch)).toBe('eu-central');
  });

  it(`gives up after ${METADATA_TIMEOUT_MS} ms, and the kind stands without a region`, async () => {
    const slow = metadata({ 'http://169.254.169.254/metadata/v1/region': { body: 'nyc3' } }, 5_000);
    const started = Date.now();
    expect(await detectKind(readers('linux', dmi('DigitalOcean', 'Droplet'), {}, slow.fetch))).toEqual({ kind: 'digitalocean' });
    expect(Date.now() - started).toBeLessThan(METADATA_TIMEOUT_MS + 700);
  });

  it('is never required: no metadata at all, or a refusal, or nonsense, still says the kind', async () => {
    expect(await detectKind(readers('linux', dmi('Google', 'Google Compute Engine')))).toEqual({ kind: 'gcp' });
    expect(await detectKind(readers('linux', dmi('Google', 'Google Compute Engine'), {}, metadata({}).fetch))).toEqual({ kind: 'gcp' });
    const odd = metadata({ 'http://169.254.169.254/metadata/v1/region': { body: '<html>captive portal</html>' } });
    expect(await detectKind(readers('linux', dmi('DigitalOcean', 'Droplet'), {}, odd.fetch))).toEqual({ kind: 'digitalocean' });
  });

  it('asks nothing of the network for a computer that isn’t a cloud server', async () => {
    const m = metadata({});
    expect(await detectKind(readers('linux', {}, {}, m.fetch))).toEqual({ kind: 'linux' });
    expect(await detectKind(readers('darwin', {}, { 'hw.model': 'Mac14,3' }, m.fetch))).toEqual({ kind: 'mac-mini' });
    expect(m.asked).toEqual([]);
  });
});

describe('which Linux, from os-release', () => {
  const OS: Array<[string, string, string, string | undefined]> = [
    ['Ubuntu 24.04', 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n', 'ubuntu', '24.04'],
    ['Debian 12', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nVERSION_ID="12"\nID=debian\n', 'debian', '12'],
    ['Fedora 41', 'NAME="Fedora Linux"\nVERSION_ID=41\nID=fedora\n', 'fedora', '41'],
    ['Arch (no version)', 'NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\n', 'arch', undefined],
    ['Alpine 3.20', 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\n', 'alpine', '3.20.3'],
    ['Rocky Linux 9', 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.4"\n', 'rocky', '9.4'],
    ['RHEL 9', 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nVERSION_ID="9.4"\n', 'rhel', '9.4'],
    ['openSUSE Tumbleweed', 'NAME="openSUSE Tumbleweed"\nID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\nVERSION_ID="20241101"\n', 'opensuse', '20241101'],
    ['Linux Mint (its own mark, not Ubuntu’s)', 'NAME="Linux Mint"\nID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_ID="22"\n', 'mint', '22'],
    ['an unknown derivative shows its parent’s', 'NAME="Zorin OS"\nID=zorin\nID_LIKE="ubuntu debian"\nVERSION_ID="17"\n', 'ubuntu', '17'],
  ];
  it.each(OS)('%s', (_name, text, distro, version) => {
    expect(distroFromOsRelease(text)).toEqual({ distro, ...(version ? { version } : {}) });
  });
  it('knows nothing it can’t name, and keeps an odd version out', () => {
    expect(distroFromOsRelease('ID=void\n')).toBeUndefined();
    expect(distroFromOsRelease(undefined)).toBeUndefined();
    expect(distroFromOsRelease('ID=ubuntu\nVERSION_ID="24.04; rm -rf /"\n')).toEqual({ distro: 'ubuntu' });
  });
  it('detectKind carries it on Linux, a cloud server included, and never on a Mac', async () => {
    const ubuntu = { '/etc/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\n' };
    expect(await detectKind(readers('linux', ubuntu))).toEqual({ kind: 'linux', distro: 'ubuntu', distroVersion: '24.04' });
    expect(await detectKind(readers('linux', { ...ubuntu, ...dmi('Amazon EC2', 'm6i.large') }))).toEqual({ kind: 'aws', distro: 'ubuntu', distroVersion: '24.04' });
    expect(await detectKind(readers('linux', { '/usr/lib/os-release': 'ID=fedora\nVERSION_ID=41\n' }))).toEqual({ kind: 'linux', distro: 'fedora', distroVersion: '41' });
    expect(await detectKind(readers('darwin', ubuntu, { 'hw.model': 'Mac14,3' }))).toEqual({ kind: 'mac-mini' });
  });
});

describe('hosts that say what they are in their environment', () => {
  const ENV: Array<[string, Record<string, string>, string]> = [
    ['GitHub Codespaces', { CODESPACES: 'true' }, 'codespaces'],
    ['Fly.io', { FLY_APP_NAME: 'beluga-box' }, 'fly'],
    ['Railway', { RAILWAY_ENVIRONMENT: 'production' }, 'railway'],
    ['Render', { RENDER: 'true' }, 'render'],
    ['Kubernetes', { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, 'kubernetes'],
  ];
  it.each(ENV)('%s', async (_name, env, kind) => {
    // They run in containers: the host wins over the container.
    expect(await localKind(readers('linux', { '/.dockerenv': '' }, {}, undefined, env))).toBe(kind);
  });
  it('a variable that says nothing changes nothing', async () => {
    expect(await localKind(readers('linux', {}, {}, undefined, { CODESPACES: 'false', HOME: '/root' }))).toBe('linux');
  });
});
