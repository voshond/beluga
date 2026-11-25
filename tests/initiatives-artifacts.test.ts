import { existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Initiatives } from '../src/core/initiatives/initiatives.js';
import { ARTIFACT_KEEP_MAX, ArtifactsSchema, artifactKindOf, initiativeOfTicket, sortedArtifacts, ticketKeyIn } from '../src/core/initiatives/model.js';
import { initiativeReportFor, linkedInitiative } from '../src/core/initiatives/report.js';
import { Store, initialState } from '../src/core/store.js';

const SELF = 'peer-12345678';
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'beluga-artifacts-'));

const setup = async () => {
  const store = new Store(initialState('room', 'auto'));
  store.dispatch({ type: 'identity', selfId: SELF, isHost: true, home: '/Users/k' });
  const root = path.join(tmp(), 'initiatives');
  const service = new Initiatives({ store, root, dir: tmp(), selfId: () => SELF, ask: () => 'r1', commit: false, now: () => Date.parse('2026-11-25T10:00:00Z'), claudeDir: tmp() });
  await service.start();
  const { slug } = await service.create({ name: 'E-Invoicing', goal: 'Ship it', epics: ['RUN-50'] }, { quiet: true });
  writeFileSync(path.join(root, slug, 'tickets.json'), JSON.stringify({ at: 'now', tickets: [{ key: 'RUN-52', epic: 'RUN-50' }, { key: 'RUN-60', parent: 'RUN-52' }] }));
  service.refresh(slug);
  const items = () => store.getState().initiatives.items;
  return { store, root, service, slug, items };
};

const worktree = (files: Record<string, string> = {}) => {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
};

describe('initiative artifacts', () => {
  it('keeps a file a worktree sends, in artifacts/ and artifacts.json, and notes it in the timeline', async () => {
    const { root, service, slug, items } = await setup();
    const dir = worktree({ '.beluga/scratch/vera report.md': '# veraPDF\n\n3 failures\n' });
    const said = await service.reportArtifact(slug, { file: path.join(dir, '.beluga/scratch/vera report.md'), title: 'veraPDF report', why: 'The golden suite fails', ticket: 'RUN-54', worktree: 'run-54-vera', project: 'platform' });
    expect(said).toContain('artifact #1');
    const saved = ArtifactsSchema.parse(JSON.parse(readFileSync(path.join(root, slug, 'artifacts.json'), 'utf8')));
    expect(saved[0]).toMatchObject({ id: 1, title: 'veraPDF report', file: 'artifacts/1-vera-report.md', name: 'vera report.md', ticket: 'RUN-54', worktree: 'run-54-vera', project: 'platform' });
    expect(readFileSync(path.join(root, slug, 'artifacts/1-vera-report.md'), 'utf8')).toContain('3 failures');
    expect(readFileSync(path.join(root, slug, 'timeline.md'), 'utf8')).toContain('- 2026-11-25 [artifact]: artifact #1 “veraPDF report” from RUN-54');
    expect(items()[0]!.artifacts).toHaveLength(1);
    expect(service.readArtifact(slug, 1)).toMatchObject({ kind: 'text', name: 'vera report.md', cut: false });
    await service.reportArtifact(slug, { file: path.join(dir, '.beluga/scratch/vera report.md'), title: 'Again' });
    expect(sortedArtifacts(items()[0]!.artifacts).map((a) => a.id)).toEqual([2, 1]);
  });

  it('reads a picture as itself, and keeps a file too big for the repo where it is', async () => {
    const { root, service, slug } = await setup();
    const dir = worktree({ 'shot.png': 'not really a png' });
    await service.reportArtifact(slug, { file: path.join(dir, 'shot.png'), title: 'Footer' });
    expect(service.readArtifact(slug, 1)).toMatchObject({ kind: 'image', mediaType: 'image/png', data: Buffer.from('not really a png').toString('base64') });
    const big = path.join(dir, 'suite.zip');
    writeFileSync(big, '');
    truncateSync(big, ARTIFACT_KEEP_MAX + 1);
    expect(await service.reportArtifact(slug, { file: big, title: 'Golden suite' })).toContain('too big for the initiatives repo');
    expect(existsSync(path.join(root, slug, 'artifacts/2-suite.zip'))).toBe(false);
    expect(service.readArtifact(slug, 2)).toEqual({ kind: 'other', name: 'suite.zip', path: big });
  });

  it('refuses a secret, a folder and a file that is not there', async () => {
    const { service, slug } = await setup();
    const dir = worktree({ '.env': 'KEY=1' });
    await expect(service.reportArtifact(slug, { file: path.join(dir, '.env'), title: 'Env' })).rejects.toThrow('secrets');
    await expect(service.reportArtifact(slug, { file: dir, title: 'Folder' })).rejects.toThrow('is a folder');
    await expect(service.reportArtifact(slug, { file: path.join(dir, 'gone.md'), title: 'Gone' })).rejects.toThrow('There is no file');
    expect(() => service.readArtifact(slug, 9)).toThrow('That artifact is gone');
  });
});

describe('report_to_initiative for a worktree', () => {
  it('finds the initiative by the worktree’s ticket, a sub-task or a key in its branch', async () => {
    const { items } = await setup();
    expect(linkedInitiative(items(), { name: 'x', path: '/w', ticket: 'RUN-52' })).toMatchObject({ ticket: 'RUN-52', item: { slug: 'e-invoicing' } });
    expect(linkedInitiative(items(), { name: 'x', path: '/w', branch: 'run-60/pdf-engine' })).toMatchObject({ ticket: 'RUN-60' });
    expect(linkedInitiative(items(), { name: 'run-50-epic-notes', path: '/w' })).toMatchObject({ ticket: 'RUN-50' });
    expect(linkedInitiative(items(), { name: 'image-1-png', path: '/w', ticket: 'SHOP-1' })).toBeUndefined();
  });

  it('sends a file from the worktree to its initiative, or to one named', async () => {
    const { root, service, slug, items } = await setup();
    const dir = worktree({ 'out/report.md': '# ok\n' });
    const linked = initiativeReportFor(service, items(), { name: 'run-52-core', path: dir, ticket: 'RUN-52', project: 'platform' })!;
    expect(linked.brief).toContain('RUN-52, a ticket of the initiative “E-Invoicing”');
    expect(await linked.report({ file: 'out/report.md', title: 'Core report' })).toContain('artifact #1');
    expect(JSON.parse(readFileSync(path.join(root, slug, 'artifacts.json'), 'utf8'))[0]).toMatchObject({ ticket: 'RUN-52', worktree: 'run-52-core', project: 'platform' });
    const loose = initiativeReportFor(service, items(), { name: 'cleanup', path: dir })!;
    expect(loose.brief).toContain('“E-Invoicing”');
    await expect(loose.report({ file: 'out/report.md', title: 'Loose' })).rejects.toThrow('name one of “E-Invoicing” (e-invoicing)');
    await expect(loose.report({ file: 'out/report.md', title: 'Loose', initiative: 'Nope' })).rejects.toThrow('There is no initiative “Nope”');
    expect(await loose.report({ file: 'out/report.md', title: 'Loose', initiative: 'e-invoicing' })).toContain('artifact #2');
    expect(initiativeReportFor(service, [], { name: 'x', path: dir })).toBeUndefined();
  });
});

describe('artifact model', () => {
  it('tells text from pictures, and finds ticket keys', () => {
    expect(['a.md', 'b.XML', 'c.png', 'd.pdf'].map(artifactKindOf)).toEqual(['text', 'text', 'image', 'other']);
    expect(ticketKeyIn('RUN-52/core-engine')).toBe('RUN-52');
    expect(ticketKeyIn('run-117-fix-nav')).toBe('RUN-117');
    expect(ticketKeyIn('cleanup')).toBeUndefined();
    expect(initiativeOfTicket([], 'RUN-1')).toBeUndefined();
  });
});
