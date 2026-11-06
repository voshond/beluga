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
