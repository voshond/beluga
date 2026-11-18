export type SkillLink = 'linked' | 'native' | 'missing' | 'other';

export type SharedSkill = {
  readonly name: string;
  readonly description: string;
  readonly file: string;
  readonly claude: SkillLink;
  readonly codex: SkillLink;
};

export type SharedSkills = {
  readonly root: string;
  readonly skills: readonly SharedSkill[];
  readonly nestedLink?: string;
};

export type DocLink = 'linked' | 'missing' | 'file' | 'elsewhere';

export type DocLinkState = {
  readonly path: string;
  readonly state: DocLink;
  readonly target?: string;
};

export type AgentsDoc = {
  readonly path: string;
  readonly text: string;
  readonly exists: boolean;
  readonly claude: DocLinkState;
  readonly codex: DocLinkState;
};

export type InstructionPieceView = {
  readonly id: string;
  readonly label: string;
  readonly when: string;
  readonly source: string;
  readonly text?: string;
};

export type AgentSetupResult = { readonly error: string } | { readonly ok: true; readonly backup?: string };

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const MACHINE_NOTE_MAX = 4000;

export const SKILL_TEXT_MAX = 100_000;

export const AGENTS_DOC_MAX = 200_000;

export const skillTemplate = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n`;

const CHANGE_CONTEXT = 2;

/**
 * A change in words: only the lines that differ, with a little around them. The same lines at the
 * start and the end are left out, so a one-line fix in a long skill reads as one line.
 */
export const skillChangeDetail = (previous: string, next: string): string => {
  const before = previous.replace(/\n$/, '').split('\n');
  const after = next.replace(/\n$/, '').split('\n');
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const from = Math.max(0, head - CHANGE_CONTEXT);
  const lines = (all: readonly string[]): string => all.slice(from, Math.min(all.length, all.length - tail + CHANGE_CONTEXT)).join('\n') || '(nothing)';
  const where = from > 0 ? ` (from line ${from + 1})` : '';
  return `Before${where}:\n${lines(before)}\n\nAfter:\n${lines(after)}`;
};
