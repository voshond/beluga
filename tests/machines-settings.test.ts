import { createHash } from 'node:crypto';
import { COMPUTER_BRANDS, type ComputerBrandMark } from '../src/shared/computer-marks.js';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoMachines } from '../src/machines/demo.js';
import type { MachineView } from '../src/machines/machines.js';
import { placeNewWork } from '../src/machines/placement.js';
import { healthOf, kindLine, loadLine, machineLook, runOnOptions } from '../packages/mac/src/machines/model.js';

/** Settings › Your Computers (BLG-780): what each row says and draws, and where new work goes. */

const T = 1_762_600_000_000;
const [mini, aws] = demoMachines({ projects: [] }, T) as [MachineView, MachineView];

describe('a computer’s row', () => {
  it('says its kind and region, and draws its kind’s mark or a fitting glyph', () => {
    expect(kindLine(aws)).toBe('AWS · eu-west-1');
    expect(kindLine(mini)).toBe('Mac mini');
    expect(kindLine({ platform: 'linux' })).toBe('Linux');
    // AWS and Azure: their own marks, from their icon sets. Apple hardware and PCs: the app's own drawing of each, never Apple's or Microsoft's marks.
    expect(machineLook(aws)).toEqual({ brand: 'aws', glyph: 'cloud' });
    expect(machineLook({ kind: 'azure', platform: 'linux' }).brand).toBe('azure');
    expect(machineLook(mini)).toEqual({ glyph: 'macMini' });
    expect(machineLook({ kind: 'mac-studio', platform: 'macos' })).toEqual({ glyph: 'macStudio' });
    expect(machineLook({ kind: 'imac', platform: 'macos' })).toEqual({ glyph: 'imac' });
    expect(machineLook({ kind: 'windows', platform: 'windows' })).toEqual({ glyph: 'pc' });
    // Linux: its distribution's mark and name, else Tux; a cloud or a container keeps its own.
    expect(machineLook({ kind: 'linux', platform: 'linux', distro: 'ubuntu' })).toEqual({ brand: 'ubuntu', glyph: 'server' });
    expect(machineLook({ kind: 'linux', platform: 'linux' })).toEqual({ brand: 'linux', glyph: 'server' });
    expect(machineLook({ kind: 'aws', platform: 'linux', distro: 'ubuntu' }).brand).toBe('aws');
    expect(machineLook({ kind: 'docker', platform: 'linux', distro: 'debian' }).brand).toBe('docker');
    expect(kindLine({ kind: 'linux', platform: 'linux', distro: 'ubuntu', distroVersion: '24.04' })).toBe('Ubuntu 24.04');
    expect(kindLine({ kind: 'linux', platform: 'linux', distro: 'arch' })).toBe('Arch Linux');
    // WSL shows its distribution and says it's WSL; other clouds, hosts and VMs have their own mark or the app's.
    expect(machineLook({ kind: 'wsl', platform: 'linux', distro: 'ubuntu' }).brand).toBe('ubuntu');
    expect(kindLine({ kind: 'wsl', platform: 'linux', distro: 'ubuntu', distroVersion: '24.04' })).toBe('Ubuntu 24.04 · WSL');
    expect(machineLook({ kind: 'codespaces', platform: 'linux' }).brand).toBe('github');
    expect(machineLook({ kind: 'linode', platform: 'linux' }).brand).toBe('akamai');
    expect(machineLook({ kind: 'virtualbox', platform: 'linux' })).toEqual({ glyph: 'vm' });
    expect(machineLook({ kind: 'oracle', platform: 'linux' })).toEqual({ glyph: 'cloud' });
    expect(machineLook({ kind: 'docker', platform: 'linux' })).toEqual({ brand: 'docker', glyph: 'box' });
    expect(machineLook({ kind: 'raspberry-pi', platform: 'linux' }).brand).toBe('raspberrypi');
    // The icon kept on the computer wins; `auto` is the kind's own.
    expect(machineLook({ ...aws, icon: 'server' })).toEqual({ glyph: 'server' });
    expect(machineLook({ ...aws, icon: 'auto' })).toEqual({ brand: 'aws', glyph: 'cloud' });
  });

  it('a line of what it has free, or how it is when it isn’t online', () => {
    expect(loadLine(aws)).toMatch(/^\d+% busy · [\d.]+ GB free · 168 GB disk · 1 working · \d+ ms$/);
    expect(loadLine({ ...aws, status: 'offline', lastSeen: T - 3 * 60_000 }, T)).toBe('Offline · seen 3 min ago');
    expect(loadLine({ ...aws, note: 'aws runs an older Beluga (0.5.0): Update It to work there again.' })).toMatch(/older Beluga/);
  });

  it('a health strip, with the fix for what isn’t ready', () => {
    expect(healthOf(mini).map((h) => [h.label, h.ok])).toEqual([
      ['Claude', true],
      ['Codex', true],
      ['gh', true],
      ['2 MCP servers', true],
    ]);
    expect(healthOf(mini)[0]!.usage).toBe('18% of 5 h');
    const aws2 = healthOf(aws);
    expect(aws2.find((h) => h.key === 'codex')).toMatchObject({ ok: false, fix: { words: 'Sign Codex in on build-box', command: 'codex login' } });
    const bare = healthOf({ name: 'pi', info: { ...aws.info!, runtimes: [], gh: 'signed_out' } });
    // Claude not set up is a fix; Codex not there at all isn't shown (you may not use it).
    expect(bare.map((h) => h.key)).toEqual(['claude', 'gh', 'mcp']);
    expect(bare.find((h) => h.key === 'gh')!.fix!.command).toBe('gh auth login');
  });
});

describe('Run New Work On', () => {
  const here = { name: 'This Mac', loadPerCore: 0.9 };
  it('offers this computer, Best Available and each computer', () => {
    expect(runOnOptions('This Mac', [mini, aws]).map((o) => o.value)).toEqual(['here', 'best', mini.id, aws.id]);
  });

  it('here, a computer by name, or the least busy that’s ready', () => {
    expect(placeNewWork('here', [mini, aws], here)).toMatchObject({ where: 'here' });
    expect(placeNewWork(aws.id, [mini, aws], here)).toMatchObject({ where: 'computer', id: aws.id });
    // The Mac mini is far less busy than the build-box and this Mac.
    expect(placeNewWork('best', [mini, aws], here)).toMatchObject({ where: 'computer', id: mini.id });
    expect(placeNewWork('best', [mini, aws], { name: 'This Mac', loadPerCore: 0 })).toMatchObject({ where: 'here' });
  });

  it('a computer that isn’t ready means this one, said in words', () => {
    const off = { ...mini, status: 'offline' as const };
    expect(placeNewWork(mini.id, [off, aws], here)).toMatchObject({ where: 'here', why: expect.stringMatching(/Mac mini at home isn’t ready \(offline\)/) });
    expect(placeNewWork('best', [off], here)).toMatchObject({ where: 'here', why: expect.stringMatching(/None of your computers is ready/) });
    expect(placeNewWork('0123456789abcdef', [mini], here)).toMatchObject({ where: 'here' });
    const older = { ...aws, readOnly: true };
    expect(placeNewWork(aws.id, [older], here).why).toMatch(/on another version/);
  });
});

/** The full-colour marks (AWS's and Azure's own icon sets), by their files' sha256. */
const FULL_COLOUR: Record<string, string> = {
  'aws.svg': '63d73df1aac59dab323df732f82e196e359fb7b6370c0ca8e51e7b897cd350be',
  'azure.svg': 'dcc1d690bc18e7c7401fb545c51790b4974a69c9d997b27c4fbd9f1f26fe6815',
};

describe('the brand marks', () => {
  it('every shipped mark is listed with its source in THIRD_PARTY_ICONS.md', () => {
    const doc = readFileSync('THIRD_PARTY_ICONS.md', 'utf8');
    const files = readdirSync('packages/mac/src/machines/icons/brands').filter((f) => f.endsWith('.svg'));
    expect(files.sort()).toEqual(['akamai.svg', 'alibabacloud.svg', 'almalinux.svg', 'alpinelinux.svg', 'archlinux.svg', 'aws.svg', 'azure.svg', 'centos.svg', 'debian.svg', 'digitalocean.svg', 'docker.svg', 'exoscale.svg', 'fedora.svg', 'flydotio.svg', 'gentoo.svg', 'github.svg', 'googlecloud.svg', 'hetzner.svg', 'kalilinux.svg', 'kubernetes.svg', 'linux.svg', 'linuxmint.svg', 'manjaro.svg', 'nixos.svg', 'opensuse.svg', 'ovh.svg', 'podman.svg', 'popos.svg', 'qemu.svg', 'railway.svg', 'raspberrypi.svg', 'redhat.svg', 'render.svg', 'rockylinux.svg', 'scaleway.svg', 'ubuntu.svg', 'upcloud.svg', 'vmware.svg', 'vultr.svg']);
    for (const f of files) expect(doc).toMatch(new RegExp(`\\| \`${f.replace('.', '\\.')}\` \\|[^\\n]*https://`));
    // As they came: a plain Simple Icons file, its own title, nothing added.
    for (const f of files.filter((f) => !(f in FULL_COLOUR))) expect(readFileSync(`packages/mac/src/machines/icons/brands/${f}`, 'utf8')).toMatch(/^<svg role="img" viewBox="0 0 24 24" xmlns="http:\/\/www\.w3\.org\/2000\/svg"><title>[^<]+<\/title><path d="[^"]+"\/><\/svg>\n?$/);
    // AWS's and Azure's, byte for byte as their icon sets ship them, and nothing that runs or loads.
    for (const [f, sha] of Object.entries(FULL_COLOUR)) {
      const svg = readFileSync(`packages/mac/src/machines/icons/brands/${f}`);
      expect(createHash('sha256').update(svg).digest('hex')).toBe(sha);
      expect(svg.toString('utf8')).not.toMatch(/<script|<foreignObject|\bon\w+=|href=/i);
    }
  });
  it('the shared marks (the phone draws these) are the shipped files, path for path', () => {
    const files = readdirSync('packages/mac/src/machines/icons/brands').filter((f) => f.endsWith('.svg'));
    expect(Object.keys(COMPUTER_BRANDS).map((k) => `${k}.svg`).sort()).toEqual(files.sort());
    for (const [key, mark] of Object.entries(COMPUTER_BRANDS) as Array<[string, ComputerBrandMark]>) {
      const svg = readFileSync(`packages/mac/src/machines/icons/brands/${key}.svg`, 'utf8');
      if (mark.svg) expect(mark.svg).toBe(svg);
      else expect(mark.d).toBe(/<path d="([^"]+)"/.exec(svg)?.[1]);
    }
  });
});

describe('a one-colour mark’s mask', () => {
  it('quotes its URL, so an inlined SVG (quotes, spaces) still masks instead of showing a coloured square', async () => {
    const { maskOf } = await import('../packages/mac/src/machines/mask.js');
    const inlined = `data:image/svg+xml,%3csvg role='img' viewBox='0 0 24 24'%3e%3cpath d='M1 2z'/%3e%3c/svg%3e`;
    expect(maskOf(inlined)).toBe(`url(${JSON.stringify(inlined)})`);
    expect(maskOf('/assets/ubuntu-3f2a.svg')).toBe('url("/assets/ubuntu-3f2a.svg")');
  });
});
