import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linkEntry } from '../agent/runtime/claude/skill-plugins.js';
import { codexDataDir } from '../agent/runtime/codex/codex-sessions.js';
import { AGENTS_DOC_MAX, type AgentSetupResult, type AgentsDoc, type DocLink, type DocLinkState, type SharedSkill, type SharedSkills, type SkillLink, SKILL_NAME_RE, SKILL_TEXT_MAX } from '../shared/agent-setup.js';
import { claudeHome } from './claude-code/launch.js';
import { frontmatter } from './claude-code/skills.js';

export type AgentDirs = { readonly agents: string; readonly claude: string; readonly codex: string };

export type DocRuntime = 'claude' | 'codex';

export const agentDirs = (): AgentDirs => ({ agents: path.join(os.homedir(), '.agents'), claude: claudeHome(), codex: codexDataDir() });

const skillsRoot = (dirs: AgentDirs): string => path.join(dirs.agents, 'skills');

const claudeSkillPath = (dirs: AgentDirs, name: string): string => path.join(dirs.claude, 'skills', name);

const docPath = (dirs: AgentDirs): string => path.join(dirs.agents, 'AGENTS.md');

const docTarget = (dirs: AgentDirs, runtime: DocRuntime): string => (runtime === 'claude' ? path.join(dirs.claude, 'CLAUDE.md') : path.join(dirs.codex, 'AGENTS.md'));

const failure = (err: unknown): AgentSetupResult => ({ error: err instanceof Error ? err.message : String(err) });

const samePlace = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

const isLink = (target: string): boolean => {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
};

const linkState = (target: string, expected: string): DocLink => {
  if (!isLink(target)) return existsSync(target) ? 'file' : 'missing';
  return samePlace(target, expected) ? 'linked' : 'elsewhere';
};

const skillLink = (target: string, expected: string): SkillLink => {
  const state = linkState(target, expected);
  if (state === 'linked' || state === 'missing') return state;
  return 'other';
};

const skillNames = (root: string): string[] => {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()) && existsSync(path.join(root, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

const nestedLinkOf = (dirs: AgentDirs): string | undefined => {
  const claudeSkills = path.join(dirs.claude, 'skills');
  try {
    return readdirSync(claudeSkills)
      .map((entry) => path.join(claudeSkills, entry))
      .find((entry) => isLink(entry) && samePlace(entry, skillsRoot(dirs)));
  } catch {
    return undefined;
  }
};

const sharedSkill = (dirs: AgentDirs, name: string): SharedSkill => {
  const dir = path.join(skillsRoot(dirs), name);
  const file = path.join(dir, 'SKILL.md');
  const { fields, firstLine } = frontmatter(readFileSync(file, 'utf8').slice(0, 8192));
  return { name, description: fields.description || firstLine, file, claude: skillLink(claudeSkillPath(dirs, name), dir), codex: 'native' };
};

export const listSharedSkills = (dirs: AgentDirs = agentDirs()): SharedSkills => {
  const nestedLink = nestedLinkOf(dirs);
  return { root: skillsRoot(dirs), skills: skillNames(skillsRoot(dirs)).map((name) => sharedSkill(dirs, name)), ...(nestedLink ? { nestedLink } : {}) };
};

export const readSharedSkill = (name: string, dirs: AgentDirs = agentDirs()): string | undefined => {
  if (!SKILL_NAME_RE.test(name)) return undefined;
  try {
    return readFileSync(path.join(skillsRoot(dirs), name, 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
};

const skillProblem = (name: string, text: string): string | undefined => {
  if (!SKILL_NAME_RE.test(name)) return 'A skill’s name is lowercase letters, digits and dashes.';
  if (text.length > SKILL_TEXT_MAX) return 'That skill is too long.';
  const { fields } = frontmatter(text);
  if (fields.name !== name) return `Start the file with frontmatter naming it: name: ${name}`;
  if (!fields.description) return 'Add a description: line to the frontmatter. Claude and Codex use it to decide when to use the skill.';
  return undefined;
};

const linkForClaude = (dirs: AgentDirs, name: string): void => {
  const target = claudeSkillPath(dirs, name);
  if (linkState(target, path.join(skillsRoot(dirs), name)) !== 'missing') return;
  mkdirSync(path.dirname(target), { recursive: true });
  linkEntry(path.join(skillsRoot(dirs), name), target);
};

export const saveSharedSkill = (name: string, text: string, create: boolean, dirs: AgentDirs = agentDirs()): AgentSetupResult => {
  const problem = skillProblem(name, text);
  if (problem) return { error: problem };
  const dir = path.join(skillsRoot(dirs), name);
  if (create && existsSync(dir)) return { error: `There is already a skill called ${name}.` };
  if (!create && !existsSync(path.join(dir, 'SKILL.md'))) return { error: `There is no skill called ${name}.` };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), text);
    linkForClaude(dirs, name);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
};

export const removeSharedSkill = (name: string, dirs: AgentDirs = agentDirs()): AgentSetupResult => {
  if (!SKILL_NAME_RE.test(name)) return { error: 'No such skill.' };
  const dir = path.join(skillsRoot(dirs), name);
  if (!existsSync(path.join(dir, 'SKILL.md'))) return { error: `There is no skill called ${name}.` };
  try {
    const link = claudeSkillPath(dirs, name);
    if (linkState(link, dir) === 'linked') unlinkSync(link);
    rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
};

export const repairSkillLinks = (dirs: AgentDirs = agentDirs()): AgentSetupResult => {
  try {
    const nested = nestedLinkOf(dirs);
    if (nested) unlinkSync(nested);
    for (const name of skillNames(skillsRoot(dirs))) linkForClaude(dirs, name);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
};

const docLinkState = (dirs: AgentDirs, runtime: DocRuntime): DocLinkState => {
  const target = docTarget(dirs, runtime);
  const state = linkState(target, docPath(dirs));
  return { path: target, state, ...(state === 'elsewhere' ? { target: readlinkSync(target) } : {}) };
};

export const readAgentsDoc = (dirs: AgentDirs = agentDirs()): AgentsDoc => {
  const file = docPath(dirs);
  const exists = existsSync(file);
  const text = exists ? readFileSync(file, 'utf8').slice(0, AGENTS_DOC_MAX) : '';
  return { path: file, text, exists, claude: docLinkState(dirs, 'claude'), codex: docLinkState(dirs, 'codex') };
};

export const saveAgentsDoc = (text: string, dirs: AgentDirs = agentDirs()): AgentSetupResult => {
  if (text.length > AGENTS_DOC_MAX) return { error: 'That file is too long.' };
  try {
    mkdirSync(dirs.agents, { recursive: true });
    writeFileSync(docPath(dirs), text);
    return { ok: true };
  } catch (err) {
    return failure(err);
  }
};

const backupName = (file: string): string => `${file}.beluga-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;

export const linkAgentsDoc = (runtime: DocRuntime, dirs: AgentDirs = agentDirs()): AgentSetupResult => {
  const doc = docPath(dirs);
  const target = docTarget(dirs, runtime);
  const state = linkState(target, doc);
  if (state === 'linked') return { ok: true };
  try {
    mkdirSync(dirs.agents, { recursive: true });
    mkdirSync(path.dirname(target), { recursive: true });
    if (state === 'file' && !existsSync(doc)) {
      renameSync(target, doc);
      linkEntry(doc, target);
      return { ok: true };
    }
    const backup = state === 'missing' ? undefined : backupName(target);
    if (backup) renameSync(target, backup);
    if (!existsSync(doc)) writeFileSync(doc, '');
    linkEntry(doc, target);
    return { ok: true, ...(backup ? { backup } : {}) };
  } catch (err) {
    return failure(err);
  }
};
