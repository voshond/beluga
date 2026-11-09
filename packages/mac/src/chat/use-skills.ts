import { useEffect, useState } from 'react';
import type { ClaudeSkill } from '@beluga/shared/skills.js';
import { useApi, useApp, useScopedKey } from '../lib/beluga.js';

/** How long a conversation's list stays fresh (a skill you just added shows the next time you type /). */
const FRESH_MS = 20_000;
const cache = new Map<string, { at: number; skills: readonly ClaudeSkill[] }>();

/**
 * Load skills and custom commands for the / list when `want` is true.
 * A new chat reads skills from its folder before a conversation exists.
 */
export function useSkills(channel: string, want: boolean): readonly ClaudeSkill[] {
  const api = useApi();
  const draftDir = useApp((state) => {
    if (state.view.kind !== 'draft') return undefined;
    const view = state.view;
    return (view.projectId === 'chats' ? view.dir : state.projects.find((p) => p.id === view.projectId)?.root) || null;
  });
  // Each computer's own list (BLG-784).
  const key = useScopedKey(channel === 'draft' ? JSON.stringify([channel, draftDir]) : channel);
  const [skills, setSkills] = useState<readonly ClaudeSkill[]>(() => cache.get(key)?.skills ?? []);
  const inConversation = channel.startsWith('ws:') || (channel === 'draft' && draftDir !== undefined);
  useEffect(() => {
    setSkills(cache.get(key)?.skills ?? []);
  }, [key]);
  useEffect(() => {
    if (!want || !inConversation) return;
    const kept = cache.get(key);
    if (kept && Date.now() - kept.at < FRESH_MS) return;
    let live = true;
    api.claudeCode.skills(channel, draftDir ?? undefined).then(
      (list) => {
        cache.set(key, { at: Date.now(), skills: list });
        if (live) setSkills(list);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, channel, want, inConversation, key, draftDir]);
  return inConversation ? skills : [];
}
