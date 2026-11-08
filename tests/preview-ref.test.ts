import { describe, expect, it } from 'vitest';
import { EXPERIMENTS, EXPERIMENT_INFO, experimentOn, withExperiment } from '../src/shared/experiments.js';
import { loopbackUrl, parsePreviewRef, previewTitle } from '../src/shared/preview/ref.js';
import { buildProblem, packageOf } from '../src/preview/problems.js';
import path from 'node:path';
import { plainLine, stripCode } from '../src/companion/strip.js';
import { withPictures } from '../src/companion/views.js';
import { runInstructions } from '../src/agent/run-instructions.js';
import { buildPreviewAppend } from '../src/agent/preview-prompt.js';

describe('a beluga-preview block', () => {
  it('names a component, an export, props over several lines, a stylesheet and a note', () => {
    const ref = parsePreviewRef('src/components/PriceCard.tsx\nexport: PriceCard\nprops: {"plan": "pro",\n  "price": 24}\ncss: src/index.css\nnote: The new card');
    expect(ref).toEqual({ target: { kind: 'component', file: 'src/components/PriceCard.tsx', export: 'PriceCard' }, props: { plan: 'pro', price: 24 }, css: 'src/index.css', note: 'The new card' });
    expect(previewTitle(ref!)).toBe('PriceCard · PriceCard.tsx');
  });

  it('names an html file or a page on this computer, at a width', () => {
    expect(parsePreviewRef('site/index.html\nsize: phone')).toEqual({ target: { kind: 'html', file: 'site/index.html' }, size: 'phone' });
    const page = parsePreviewRef('http://localhost:5173/pricing');
    expect(page?.target).toEqual({ kind: 'url', url: 'http://localhost:5173/pricing' });
    expect(previewTitle(page!)).toBe('localhost:5173/pricing');
  });

  it('never frames the open web, nor reaches outside the worktree', () => {
    expect(parsePreviewRef('https://example.com')).toBeUndefined();
    expect(loopbackUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000/');
    expect(loopbackUrl('http://localhost.evil.com/')).toBeUndefined();
    // Only what the window may frame: http on localhost or 127.0.0.1.
    expect(loopbackUrl('https://localhost:5173/')).toBeUndefined();
    expect(loopbackUrl('http://[::1]:5173/')).toBeUndefined();
    expect(loopbackUrl('file:///etc/passwd')).toBeUndefined();
    expect(parsePreviewRef('../../etc/passwd.js')).toBeUndefined();
    expect(parsePreviewRef('/Users/me/App.tsx')).toBeUndefined();
    expect(parsePreviewRef('README.md')).toBeUndefined();
    expect(parsePreviewRef('src/App.tsx\ncss: ../../secret.css')?.css).toBeUndefined();
  });

  it('ignores props that aren’t an object', () => {
    expect(parsePreviewRef('src/App.tsx\nprops: [1, 2]')?.props).toBeUndefined();
    expect(parsePreviewRef('src/App.tsx\nprops: {oops')?.props).toBeUndefined();
  });
});

describe('a build that failed, in plain words', () => {
  const at = (text: string, file = 'src/Card.tsx', line = 12) => ({ text, location: { file, line, column: 4, lineText: '  return <div>' } });

  it('says the packages aren’t installed when React (or anything) can’t be found in a bare worktree', () => {
    expect(buildProblem([at('Could not resolve "react"')], 'src/Card.tsx', true).kind).toBe('not-installed');
    expect(buildProblem([at('Could not resolve "clsx"')], 'src/Card.tsx', false).kind).toBe('not-installed');
  });

  it('names a missing package, a missing file, or the line that doesn’t read', () => {
    const pkg = buildProblem([at('Could not resolve "@radix-ui/react-dialog/dist/index"')], 'src/Card.tsx', true);
    expect(pkg.title).toBe('Card.tsx uses @radix-ui/react-dialog, which isn’t installed');
    expect(buildProblem([at('Could not resolve "./Missing"')], 'src/Card.tsx', true).kind).toBe('missing-import');
    const syntax = buildProblem([at('Expected ";" but found "}"', 'src/Card.tsx', 31)], 'src/Card.tsx', true);
    expect(syntax).toMatchObject({ kind: 'syntax', title: 'Card.tsx doesn’t read right around line 31' });
  });

  it('keeps the bundler’s words out of what you see, and gives them to your agent', () => {
    const p = buildProblem([at('Expected ";" but found "}"')], 'src/Card.tsx', true);
    expect(`${p.title} ${p.detail}`).not.toMatch(/Expected|esbuild|resolve/);
    expect(p.forClaude).toContain('src/Card.tsx:12:4: Expected ";" but found "}"');
    expect(packageOf('lodash/fp')).toBe('lodash');
  });
});

describe('experiments', () => {
  it('are off until turned on, and keep ids a newer Beluga knows', () => {
    expect(experimentOn([], 'previews')).toBe(false);
    expect(withExperiment(['future'], 'previews', true)).toEqual(['future', 'previews']);
    expect(withExperiment(['future', 'previews'], 'previews', false)).toEqual(['future']);
    for (const id of EXPERIMENTS) expect(EXPERIMENT_INFO[id].changes.length).toBeGreaterThan(0);
  });

  it('tell your agent about previews only when on, and never in its terminal', () => {
    const base = { prompt: 'hi', requesterName: 'Kayra', viaAgent: false, context: [], channel: 'ws:1', scope: 'full' } as unknown as Parameters<typeof runInstructions>[0];
    const brief = buildPreviewAppend();
    expect(runInstructions(base, 'Kayra')).not.toContain('beluga-preview');
    expect(runInstructions({ ...base, previewBrief: brief } as typeof base, 'Kayra')).toContain('```beluga-preview');
    expect(runInstructions({ ...base, previewBrief: brief, terminal: true } as unknown as typeof base, 'Kayra')).not.toContain('Live previews (an experimental');
  });
});

describe('the phone', () => {
  const said = 'Here it is:\n\n```beluga-preview\nsrc/components/PriceCard.tsx\nprops: {"plan": "pro"}\n```\n\nDone.';
  const refs = (found: string | undefined) => ({ output: (p: string) => (found && p === found ? { kind: 'image' as const, ref: 'out:1', name: 'x.png' } : undefined) }) as unknown as Parameters<typeof withPictures>[1];

  it('never gets the block as code', () => {
    const view = stripCode(said);
    expect(view.code).toEqual([]);
    expect(view.text).not.toContain('props');
    expect(plainLine(said)).toBe('Here it is: A live preview of PriceCard.tsx, on your Mac Done.');
  });

  it('shows the newest picture of it where the Mac drew one, and says it in words where not', () => {
    const still = path.join('/w', '.beluga', 'scratch', 'previews', 'src_components_PriceCard.tsx.png');
    expect(withPictures(stripCode(said), refs(still), '/w').text).toContain('![A live preview of PriceCard.tsx, on your Mac](out:1)');
    expect(withPictures(stripCode(said), refs(undefined), '/w').text).toContain('_A live preview of PriceCard.tsx, on your Mac._');
  });
});
