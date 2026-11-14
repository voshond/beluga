// Keys pasted into the chat box (BLG-965): where keeping them puts them, and the card's words.
// The values stay on this Mac and in the daemon; the chat gets `$NAME` in their place.
import type { EnvVar } from '@beluga/shared/env-vars.js';
import { ENV_KEY } from '@beluga/shared/env-vars.js';
import type { KeyWhy } from '@beluga/shared/key-detect.js';

/** Where kept keys go: this chat (its workspace), a worktree still being made, a new chat's project, or yours. */
export type KeyTarget =
  | { readonly kind: 'chat'; readonly workspaceId: string; readonly worktree: boolean }
  | { readonly kind: 'draft'; readonly projectId: string }
  | { readonly kind: 'project'; readonly projectId: string; readonly projectName: string }
  | { readonly kind: 'yours' };

/** One key on the card, with the name you may change. */
export interface OfferedKey {
  readonly value: string;
  readonly name: string;
  readonly what: string;
  readonly product?: string;
  readonly why: KeyWhy;
  readonly from?: string;
  readonly replaces?: boolean;
}

/** The place a box sends to, from its channel and view. */
export function targetOf(channel: string, view: { readonly draftProject?: string; readonly newChatProject?: { readonly id: string; readonly name: string }; readonly worktree?: boolean }): KeyTarget {
  if (channel.startsWith('ws:')) return { kind: 'chat', workspaceId: channel.slice(3), worktree: view.worktree ?? true };
  if (view.draftProject) return { kind: 'draft', projectId: view.draftProject };
  if (view.newChatProject) return { kind: 'project', projectId: view.newChatProject.id, projectName: view.newChatProject.name };
  return { kind: 'yours' };
}

/** What the daemon looks in for names like yours. */
export const placeOf = (t: KeyTarget): { workspaceId?: string; projectId?: string } => (t.kind === 'chat' ? { workspaceId: t.workspaceId } : t.kind === 'draft' || t.kind === 'project' ? { projectId: t.projectId } : {});

/** The card's title: what was pasted, in words. */
export function titleOf(keys: readonly OfferedKey[]): string {
  if (keys.length > 1) return `You pasted ${keys.length} secret keys`;
  const k = keys[0]!;
  if (k.why === 'yours') return `That’s your ${k.name}`;
  return `That looks like ${k.what}`;
}

/** Where they're kept, in a line under the names. */
export function scopeLine(t: KeyTarget, agent: string, n: number): string {
  const them = n === 1 ? 'it' : 'them';
  switch (t.kind) {
    case 'chat':
      return t.worktree ? `Kept in Beluga for this chat only. ${agent} uses ${them} by name; when you merge or archive, you choose whether the project keeps ${them}.` : `Kept in Beluga for this chat only. ${agent} uses ${them} by name.`;
    case 'draft':
      return `Kept in Beluga for the new worktree only. ${agent} uses ${them} by name; when you merge or archive, you choose whether the project keeps ${them}.`;
    case 'project':
      return `Kept in Beluga with ${t.projectName}’s variables. ${agent} uses ${them} by name.`;
    case 'yours':
      return `Kept in Beluga with your variables (Settings › Environment). ${agent} uses ${them} by name.`;
  }
}

/** The main button. */
export function keepLabel(keys: readonly OfferedKey[]): string {
  if (keys.every((k) => k.why === 'yours')) return keys.length === 1 ? `Use $${keys[0]!.name}` : 'Use Your Variables';
  return keys.length === 1 ? 'Keep It Safe' : `Keep ${keys.length} Keys Safe`;
}

/** What's wrong with the names on the card (by index): a bad name or one used twice. */
export function nameProblems(keys: readonly OfferedKey[]): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  const seen = new Set<string>();
  keys.forEach((k, i) => {
    if (!k.name) out.set(i, 'Give it a name');
    else if (!ENV_KEY.test(k.name)) out.set(i, 'Letters, digits and _ only');
    else if (seen.has(k.name)) out.set(i, 'Used twice');
    seen.add(k.name);
  });
  return out;
}

/** A name typed into the card: upper case, spaces and dashes as _. */
export const tidyName = (raw: string): string => raw.toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');

/** The rows to keep: everything but keys that are yours already (those are set). */
export const rowsOf = (keys: readonly OfferedKey[]): EnvVar[] => keys.filter((k) => k.why !== 'yours').map((k) => ({ key: k.name, value: k.value }));

/**
 * Keys held for a worktree that isn't made yet, by its box (a new worktree's page): they go with
 * its first message (startWorktree's `vars`), so its first run has them. Never written anywhere.
 */
const held = new Map<string, readonly EnvVar[]>();

export function holdKeys(box: string, rows: readonly EnvVar[]): void {
  const before = (held.get(box) ?? []).filter((r) => !rows.some((n) => n.key === r.key));
  held.set(box, [...before, ...rows]);
}

/** The keys held for a box, still referenced in its words (one you took out of the message isn't kept). */
export function heldFor(box: string, words: string): EnvVar[] {
  return (held.get(box) ?? []).filter((r) => words.includes(`$${r.key}`));
}

export const forgetHeld = (box: string): void => void held.delete(box);

/** The keys held for a box, all of them (the Keys panel of a new worktree's page). */
export const heldList = (box: string): readonly EnvVar[] => held.get(box) ?? [];

/** Replace the keys held for a box (renamed, a new value, one removed). */
export function setHeld(box: string, rows: readonly EnvVar[]): void {
  if (rows.length) held.set(box, rows);
  else held.delete(box);
}

/** The box's words with `$OLD` renamed `$NEW` (a key renamed in the Keys panel). */
export const renameRef = (words: string, from: string, to: string): string => words.replace(new RegExp(`\\$${from}(?![A-Za-z0-9_])`, 'g'), `$$${to}`);
