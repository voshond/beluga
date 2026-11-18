/**
 * When a shared skill is right, in one place: an agent's own instructions (agent/skill-tools.ts)
 * and the reflection pass's skill look (core/memory/reflection-skills.ts, BLG-106) both read these,
 * so the two judge by the same rules. Browser-safe: words only.
 */

/** What a new skill is for. */
export const SKILL_NEW_WHEN =
  'multi-step work the user is likely to want again (a deploy, a release, a setup that took several tries), where the steps found would save the next run from finding them again';

/** What a fix to a skill is for. */
export const SKILL_FIX_WHEN = 'a skill that was followed was wrong, out of date or left out a step that mattered';

/** What a skill is never for. */
export const SKILL_NEVER_FOR =
  'a one-off, for something this project’s own docs or CLAUDE.md already say, for what only fits this one repo, or a skill about the user’s preferences (that is memory, not a skill)';

export const SKILL_NO_SECRETS = 'Never put a secret in a skill: name the variable that holds it.';
