import type { Call } from './calls';
import type { SINCE, Topic } from './protocol';

/**
 * A screen on your Mac (`on` undefined) or on one of your computers (BLG-810): what it can do and
 * where its calls go, one place for both. Pure (the store is passed in), so
 * tests/companion-conv-scope.test.ts runs it for a Mac conversation and a computer's without React Native.
 */

export type Feature = keyof typeof SINCE;

/** What the helpers need of lib/store.ts. */
export interface ScopeStore {
  supports(what: Feature): boolean;
  supportsOn(on: string, what: Feature): boolean;
  call<T = unknown>(c: Call, opts?: { queue?: boolean; on?: string }): Promise<T | undefined>;
}

export interface Scope {
  readonly on: string | undefined;
  /** Does the Mac, or that computer, have this (its protocol's minor)? */
  readonly supports: (what: Feature) => boolean;
  /** A call on the Mac, or over that computer's link (never queued there). */
  readonly call: <T = unknown>(c: Call, opts?: { queue?: boolean }) => Promise<T | undefined>;
  /** Options for sends.message: that computer, or nothing for your Mac. */
  readonly where: { readonly on?: string };
}

export function scoped(store: ScopeStore, on: string | undefined): Scope {
  return {
    on,
    supports: (what) => (on ? store.supportsOn(on, what) : store.supports(what)),
    call: <T = unknown>(c: Call, opts: { queue?: boolean } = {}) => store.call<T>(c, { ...opts, ...(on ? { on } : {}) }),
    where: on ? { on } : {},
  };
}

/** What a conversation's screen reads to decide its rows. */
export interface ConvFacts {
  readonly topic: Topic;
  readonly agent?: unknown;
  readonly mergeable?: boolean;
  readonly branch?: unknown;
  /** One of Your Mac's chats (conv:mac:…) and the Mac has them (SINCE.macChats). */
  readonly macTopic: boolean;
  /** A request asked of a friend's agent (conv:task:…). */
  readonly askedTask: boolean;
}

/**
 * The conversation's band and ••• rows: the branch band's Merge, Agent, Merge…, Files, Terminal,
 * Open on Your Mac, Your Mac's chats, Forget. On a computer, what only your Mac does is left out
 * (its files, terminals, merges and chats stay on that computer for now).
 */
export function convAbilities(scope: Scope, c: ConvFacts | undefined) {
  const here = !scope.on;
  const hasFolder = Boolean(c && (c.topic.startsWith('conv:ws:') || c.mergeable));
  return {
    hasFolder,
    branchMerge: Boolean(c?.mergeable) && scope.supports('merge'),
    agentPicker: Boolean(c?.agent) && scope.supports('agentPicker'),
    merge: here && Boolean(c?.mergeable) && scope.supports('merge') && !c?.branch,
    files: here && hasFolder && scope.supports('files'),
    terminal: here && hasFolder && scope.supports('terminal'),
    openOnMac: here,
    macChats: here && Boolean(c?.macTopic) && scope.supports('macChats'),
    forget: Boolean(c?.askedTask) && scope.supports('forget'),
  };
}
