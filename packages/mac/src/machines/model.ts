// Relative, not @beluga: the root's tests and typecheck read this file too.
import type { MachineKind } from '../../../../src/machines/kind.js';
import type { MachineView } from '../../../../src/machines/machines.js';
import type { MachineIcon } from '../../../../src/shared/settings-schema.js';
import { DISTRO_WORDS, KIND_WORDS } from '../../../../src/machines/words.js';
import type { LinuxDistro } from '../../../../src/machines/kind.js';
// Which mark a computer shows is shared with the phone (src/machines/look.ts).
export { type Brand, machineLook } from '../../../../src/machines/look.js';

/**
 * How Settings › Your Computers says and draws a computer (BLG-780): its kind in words, its icon
 * (the one kept on it, else its kind's brand mark or a fitting glyph), a line of what it has free,
 * and what isn't ready there with its fix. Pure, so it's tested without a window.
 */


// Said the same on the phone (BLG-810).
export { KIND_WORDS } from '../../../../src/machines/words.js';



/** The generic icons to pick from, in order (`auto` is the kind's own). */
export const ICON_CHOICES: ReadonlyArray<{ readonly value: MachineIcon; readonly label: string }> = [
  { value: 'auto', label: 'Its kind’s' },
  { value: 'server', label: 'Server' },
  { value: 'cloud', label: 'Cloud' },
  { value: 'desktop', label: 'Desktop' },
  { value: 'laptop', label: 'Laptop' },
  { value: 'chip', label: 'Chip' },
  { value: 'box', label: 'Box' },
];


/** "AWS · eu-west-1", "Mac mini", or the platform when the kind isn't known yet. */
export function kindLine(m: Pick<MachineView, 'kind' | 'region' | 'platform'> & { readonly distro?: LinuxDistro; readonly distroVersion?: string }): string {
  // A plain Linux box says which one: "Ubuntu 24.04".
  if (m.distro && (!m.kind || m.kind === 'linux' || m.kind === 'wsl')) return [DISTRO_WORDS[m.distro], m.distroVersion].filter(Boolean).join(' ') + (m.kind === 'wsl' ? ' · WSL' : '');
  const kind = m.kind ? KIND_WORDS[m.kind] : m.platform === 'macos' ? 'Mac' : m.platform === 'windows' ? 'Windows' : 'Linux';
  return m.region ? `${kind} · ${m.region}` : kind;
}

/** One line of what it has free, or how it is when it isn't online. */
export function loadLine(m: Pick<MachineView, 'status' | 'info' | 'rttMs' | 'note' | 'lastSeen'>, now = Date.now()): string {
  if (m.note) return m.note;
  if (m.status !== 'online') return m.status === 'offline' ? `Offline${m.lastSeen ? ` · seen ${ago(now - m.lastSeen)} ago` : ''}` : 'Looking for it…';
  const i = m.info;
  if (!i) return 'Online';
  const parts = [`${Math.round(i.loadPerCore * 100)}% busy`, `${i.memory.freeGB} GB free`, ...(i.disk ? [`${Math.round(i.disk.freeGB)} GB disk`] : []), ...(i.agentsRunning ? [`${i.agentsRunning} working`] : []), ...(m.rttMs !== undefined ? [`${m.rttMs} ms`] : [])];
  return parts.join(' · ');
}

const ago = (ms: number): string => {
  const min = Math.round(ms / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min` : min < 60 * 24 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
};

/** One item of a computer's health strip: ready, or not with its fix. */
export interface Health {
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  /** What isn't ready, in words, and the command that fixes it there. */
  readonly fix?: { readonly words: string; readonly command?: string };
  /** Plan usage, when it's known ("42% of 5 h"). */
  readonly usage?: string;
}

/** Claude, Codex, gh and the MCP servers there, each ready or with its fix. */
export function healthOf(m: Pick<MachineView, 'name' | 'info'>): Health[] {
  const i = m.info;
  if (!i) return [];
  /** A runtime's state there; one you don't use there (not installed and `optional`) isn't shown. */
  const rt = (id: string, label: string, signIn: string, optional = false): Health[] => {
    const r = i.runtimes.find((x) => x.id === id);
    const used = r?.usage?.fiveHour ? `${Math.round(r.usage.fiveHour.pct)}% of 5 h` : r?.usage?.week ? `${Math.round(r.usage.week.pct)}% of the week` : undefined;
    if (r?.state === 'ready') return [{ key: id, label, ok: true, ...(used ? { usage: used } : {}) }];
    if (r?.state === 'signed_out') return [{ key: id, label, ok: false, fix: { words: `Sign ${label} in on ${m.name}`, command: signIn } }];
    return optional ? [] : [{ key: id, label, ok: false, fix: { words: `${label} isn’t set up on ${m.name}`, command: 'beluga setup' } }];
  };
  return [
    ...rt('claude', 'Claude', 'claude auth login'),
    ...rt('codex', 'Codex', 'codex login', true),
    i.gh === 'signed_in' ? { key: 'gh', label: 'gh', ok: true } : { key: 'gh', label: 'gh', ok: false, fix: { words: i.gh === 'missing' ? `gh isn’t on ${m.name}` : `Sign gh in on ${m.name}`, command: 'gh auth login' } },
    { key: 'mcp', label: i.mcp.length === 1 ? '1 MCP server' : `${i.mcp.length} MCP servers`, ok: true },
  ];
}

/** Run New Work On's choices: this computer, Best Available, and each computer by name. */
export function runOnOptions(here: string, machines: ReadonlyArray<Pick<MachineView, 'id' | 'name'>>): Array<{ value: string; label: string }> {
  return [{ value: 'here', label: here }, { value: 'best', label: 'Best Available' }, ...machines.map((m) => ({ value: m.id, label: m.name }))];
}
