import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUCTION_PIECES, instructionPieces, runInstructions } from '../src/agent/run-instructions.js';
import { buildMachineAppend } from '../src/agent/prompt.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { type AgentDirs, linkAgentsDoc, listSharedSkills, readAgentsDoc, readSharedSkill, removeSharedSkill, repairSkillLinks, saveAgentsDoc, saveSharedSkill } from '../src/core/agent-setup.js';
import { skillTemplate } from '../src/shared/agent-setup.js';

const dirsFor = (): AgentDirs => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-agent-setup-'));
  return { agents: path.join(home, '.agents'), claude: path.join(home, '.claude'), codex: path.join(home, '.codex') };
};

const writeSkill = (dirs: AgentDirs, name: string): void => {
  mkdirSync(path.join(dirs.agents, 'skills', name), { recursive: true });
  writeFileSync(path.join(dirs.agents, 'skills', name, 'SKILL.md'), skillTemplate(name, `Use ${name}`));
};

const isLinkTo = (link: string, target: string): boolean => lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(target);

describe('shared skills', () => {
  it('lists skills with Codex reading them natively and Claude needing a link', () => {
    const dirs = dirsFor();
    writeSkill(dirs, 'deploy');
    const { skills } = listSharedSkills(dirs);
    expect(skills).toEqual([expect.objectContaining({ name: 'deploy', description: 'Use deploy', claude: 'missing', codex: 'native' })]);
  });

  it('finds a link to the whole folder one level too deep, and repair replaces it with one link per skill', () => {
    const dirs = dirsFor();
    writeSkill(dirs, 'deploy');
    writeSkill(dirs, 'review');
    mkdirSync(path.join(dirs.claude, 'skills'), { recursive: true });
    symlinkSync(path.join(dirs.agents, 'skills'), path.join(dirs.claude, 'skills', 'skills'));
    expect(listSharedSkills(dirs).nestedLink).toBe(path.join(dirs.claude, 'skills', 'skills'));

    expect(repairSkillLinks(dirs)).toEqual({ ok: true });
    const after = listSharedSkills(dirs);
    expect(after.nestedLink).toBeUndefined();
    expect(after.skills.map((s) => s.claude)).toEqual(['linked', 'linked']);
    expect(readdirSync(path.join(dirs.claude, 'skills')).sort()).toEqual(['deploy', 'review']);
    expect(existsSync(path.join(dirs.agents, 'skills', 'deploy', 'SKILL.md'))).toBe(true);
  });

  it('never replaces a skill folder Claude has of its own', () => {
    const dirs = dirsFor();
    writeSkill(dirs, 'deploy');
    mkdirSync(path.join(dirs.claude, 'skills', 'deploy'), { recursive: true });
    writeFileSync(path.join(dirs.claude, 'skills', 'deploy', 'SKILL.md'), 'mine');
    repairSkillLinks(dirs);
    expect(listSharedSkills(dirs).skills[0]!.claude).toBe('other');
    expect(readFileSync(path.join(dirs.claude, 'skills', 'deploy', 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it('creates, edits and deletes a skill, linking it for Claude', () => {
    const dirs = dirsFor();
    expect(saveSharedSkill('deploy', skillTemplate('deploy', 'Deploy to the NAS'), true, dirs)).toEqual({ ok: true });
    expect(isLinkTo(path.join(dirs.claude, 'skills', 'deploy'), path.join(dirs.agents, 'skills', 'deploy'))).toBe(true);
    expect(saveSharedSkill('deploy', skillTemplate('deploy', 'again'), true, dirs)).toEqual({ error: 'There is already a skill called deploy.' });

    const edited = `${skillTemplate('deploy', 'Deploy to the NAS over SSH')}Run scripts/deploy.sh.\n`;
    expect(saveSharedSkill('deploy', edited, false, dirs)).toEqual({ ok: true });
    expect(readSharedSkill('deploy', dirs)).toBe(edited);

    expect(removeSharedSkill('deploy', dirs)).toEqual({ ok: true });
    expect(existsSync(path.join(dirs.agents, 'skills', 'deploy'))).toBe(false);
    expect(existsSync(path.join(dirs.claude, 'skills', 'deploy'))).toBe(false);
  });

  it('refuses a skill without the frontmatter both agents need', () => {
    const dirs = dirsFor();
    expect(saveSharedSkill('deploy', '# deploy', true, dirs)).toMatchObject({ error: expect.stringContaining('name: deploy') });
    expect(saveSharedSkill('deploy', '---\nname: deploy\n---\n', true, dirs)).toMatchObject({ error: expect.stringContaining('description') });
    expect(saveSharedSkill('Bad Name', skillTemplate('Bad Name', 'x'), true, dirs)).toMatchObject({ error: expect.any(String) });
    expect(readSharedSkill('../etc', dirs)).toBeUndefined();
  });
});

describe('the global AGENTS.md', () => {
  it('saves it and links Claude and Codex to it', () => {
    const dirs = dirsFor();
    expect(saveAgentsDoc('# Rules\n', dirs)).toEqual({ ok: true });
    expect(readAgentsDoc(dirs)).toMatchObject({ exists: true, text: '# Rules\n', claude: { state: 'missing' }, codex: { state: 'missing' } });
    expect(linkAgentsDoc('claude', dirs)).toEqual({ ok: true });
    expect(linkAgentsDoc('codex', dirs)).toEqual({ ok: true });
    const doc = readAgentsDoc(dirs);
    expect([doc.claude.state, doc.codex.state]).toEqual(['linked', 'linked']);
    expect(readFileSync(path.join(dirs.claude, 'CLAUDE.md'), 'utf8')).toBe('# Rules\n');
  });

  it('adopts a CLAUDE.md of its own when there is no shared file yet', () => {
    const dirs = dirsFor();
    mkdirSync(dirs.claude, { recursive: true });
    writeFileSync(path.join(dirs.claude, 'CLAUDE.md'), 'mine');
    expect(linkAgentsDoc('claude', dirs)).toEqual({ ok: true });
    expect(readAgentsDoc(dirs)).toMatchObject({ text: 'mine', claude: { state: 'linked' } });
  });

  it('backs up a file of its own before linking over it', () => {
    const dirs = dirsFor();
    saveAgentsDoc('shared', dirs);
    mkdirSync(dirs.codex, { recursive: true });
    writeFileSync(path.join(dirs.codex, 'AGENTS.md'), 'codex only');
    const result = linkAgentsDoc('codex', dirs);
    expect(result).toMatchObject({ ok: true, backup: expect.stringContaining('AGENTS.md.beluga-backup-') });
    expect('backup' in result && result.backup ? readFileSync(result.backup, 'utf8') : '').toBe('codex only');
    expect(readAgentsDoc(dirs).codex.state).toBe('linked');
  });
});

describe('built-in instructions', () => {
  const input = (more: Partial<AgentRunInput> = {}): AgentRunInput => ({ prompt: 'hi', requesterName: 'kay', viaAgent: false, context: [], channel: 'ws:x', scope: 'full', signal: new AbortController().signal, onEvent: () => undefined, canUseTool: async () => ({ behavior: 'allow' }), ...more }) as AgentRunInput;

  it('adds the machine note to a run that carries it, right after who it is', () => {
    const note = 'SSH keys to the NAS are on this computer.';
    const text = runInstructions(input({ machineBrief: buildMachineAppend(note) }), 'kay');
    expect(text).toContain(note);
    expect(text.indexOf(note)).toBeLessThan(text.indexOf('Graphs:'));
    expect(runInstructions(input(), 'kay')).not.toContain('<machine_context>');
  });

  it('shows every piece, with the text of the fixed ones', () => {
    const pieces = instructionPieces('kay', 'NAS');
    expect(pieces.map((p) => p.id)).toEqual(INSTRUCTION_PIECES.map((p) => p.id));
    expect(pieces.find((p) => p.id === 'room')?.text).toContain('running inside Beluga');
    expect(pieces.find((p) => p.id === 'machine')?.text).toContain('NAS');
    expect(pieces.find((p) => p.id === 'task')?.text).toBeUndefined();
    expect(instructionPieces('kay').find((p) => p.id === 'machine')?.text).toBeUndefined();
  });
});
