import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tailwindEntry } from '../src/preview/project.js';
import { expandGlob, globRegex, rewriteGlobs } from '../src/preview/vite.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'beluga-vite-'));
  for (const dir of ['src/locales/extra', 'src/utils', 'src/styles', 'node_modules/tailwindcss']) mkdirSync(path.join(root, dir), { recursive: true });
  for (const [file, text] of Object.entries({
    'src/locales/de.json': '{"hi":"Hallo"}',
    'src/locales/en.json': '{"hi":"Hello"}',
    'src/locales/notes.md': '#',
    'src/locales/extra/fr.json': '{"hi":"Salut"}',
    'src/utils/i18n.ts': "const modules = import.meta.glob('../locales/*.json', { eager: true });\nexport default modules;\n",
    'src/styles/index.css': '@import "./tailwind.css";\n@import "./font.css";\n',
    'src/styles/tailwind.css': '@import "tailwindcss";\n',
    'src/styles/font.css': 'body { font-family: sans-serif }\n',
    'node_modules/tailwindcss/package.json': '{"name":"tailwindcss","version":"4.1.0"}',
  })) writeFileSync(path.join(root, file), text);
  symlinkSync('/etc', path.join(root, 'src', 'locales', 'outside'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Vite's import.meta in a preview", () => {
  it('reads globs as Vite does', () => {
    expect(globRegex('../locales/*.json').test('../locales/de.json')).toBe(true);
    expect(globRegex('../locales/*.json').test('../locales/extra/fr.json')).toBe(false);
    expect(globRegex('./**/*.json').test('./extra/fr.json')).toBe(true);
    expect(globRegex('./**/*.json').test('./de.json')).toBe(true);
    expect(globRegex('./*.{json,md}').test('./notes.md')).toBe(true);
  });

  it('finds the files a glob names, inside the worktree only', () => {
    const importer = path.join(root, 'src', 'utils', 'i18n.ts');
    expect(expandGlob(root, importer, ['../locales/*.json'])).toEqual(['../locales/de.json', '../locales/en.json']);
    expect(expandGlob(root, importer, ['../locales/**/*.json', '!**/en.json'])).toEqual(['../locales/de.json', '../locales/extra/fr.json']);
    expect(expandGlob(root, importer, ['/src/locales/*.json'])).toEqual(['/src/locales/de.json', '/src/locales/en.json']);
    expect(expandGlob(root, importer, ['../../../*'])).toEqual([]);
  });

  it('turns a glob into the imports it stands for', () => {
    const importer = path.join(root, 'src', 'utils', 'i18n.ts');
    const eager = rewriteGlobs("const m = import.meta.glob('../locales/*.json', { eager: true });", root, importer)!;
    expect(eager).toContain('import * as __belugaGlob0_0 from "../locales/de.json";');
    expect(eager).toContain('const m = ({"../locales/de.json": __belugaGlob0_0, "../locales/en.json": __belugaGlob0_1});');
    const lazy = rewriteGlobs("const m = import.meta.glob<{ default: string }>(['../locales/*.json'], { import: 'default' });", root, importer)!;
    expect(lazy).toContain('"../locales/de.json": () => import("../locales/de.json").then((m) => m["default"])');
    const named = rewriteGlobs("import.meta.glob('../locales/*.json', { eager: true, import: 'default' })", root, importer)!;
    expect(named).toContain('import __belugaGlob0_0 from "../locales/de.json";');
    expect(rewriteGlobs('const x = import.meta.env.MODE;', root, importer)).toBeUndefined();
  });

  it("finds a project's Tailwind stylesheet through the files it imports", () => {
    expect(tailwindEntry(root)).toBe(path.join(root, 'src', 'styles', 'index.css'));
  });
});
