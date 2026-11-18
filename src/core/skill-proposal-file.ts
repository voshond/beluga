import path from 'node:path';
import { z } from 'zod';
import { JsonFile, readJson } from '../net/mesh/files.js';
import { secretIn } from '../shared/secret-text.js';
import { belugaHome } from './home.js';
import { MAX_PENDING_SKILLS, skillSecret } from './skill-proposals.js';
import type { SkillProposal, Store } from './store.js';

/**
 * Skill proposals waiting for your answer (BLG-103), kept in ~/.beluga/skill-proposals.json (0600,
 * written a moment after a change and on stop) so a daemon restart doesn't drop them. A proposal
 * that holds anything a secret check refuses stays in memory only.
 */

const SAVE_MS = 1000;

const Saved = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  text: z.string().max(200_000),
  previous: z.string().max(200_000).optional(),
  reason: z.string().max(10_000).optional(),
  from: z.string().max(200),
  askedAt: z.number(),
});

export const skillProposalsPath = (): string => path.join(belugaHome(), 'skill-proposals.json');

const safeToKeep = (p: SkillProposal): boolean => !secretIn(JSON.stringify(p)) && [p.text, p.previous ?? '', p.reason ?? ''].every((t) => !skillSecret(t));

export const loadSkillProposals = (file: string = skillProposalsPath()): SkillProposal[] => {
  const raw = readJson(file);
  if (!Array.isArray(raw)) return [];
  const kept = raw.flatMap((x): SkillProposal[] => {
    const parsed = Saved.safeParse(x);
    return parsed.success && safeToKeep(parsed.data) ? [parsed.data] : [];
  });
  return kept.sort((a, b) => a.askedAt - b.askedAt).slice(-MAX_PENDING_SKILLS);
};

export const keptSkillProposals = (proposals: readonly SkillProposal[]): SkillProposal[] => proposals.filter(safeToKeep);

export const launchSkillProposals = (opts: { readonly store: Store; readonly file?: string }): (() => void) => {
  const file = opts.file ?? skillProposalsPath();
  for (const proposal of loadSkillProposals(file)) opts.store.dispatch({ type: 'skill_proposal_add', proposal });
  const saved = new JsonFile(file, () => keptSkillProposals(opts.store.getState().skillProposals), SAVE_MS);
  let last = opts.store.getState().skillProposals;
  const off = opts.store.subscribe(() => {
    const now = opts.store.getState().skillProposals;
    if (now === last) return;
    last = now;
    saved.changed();
  });
  return () => {
    off();
    try {
      saved.flush();
    } catch {
      return;
    }
  };
};
