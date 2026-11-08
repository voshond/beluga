import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PreviewManager, worktreeFile } from '../src/preview/manager.js';
import { PREVIEW_HANDLERS } from '../src/ipc/preview-handlers.js';
import { PreviewServer } from '../src/preview/server.js';
import type { PreviewResult } from '../src/shared/preview/opened.js';
import type { Session } from '../src/core/session.js';

/**
 * Live previews end to end on this computer: a component built with esbuild against React (the
 * Mac app's own copy, linked in as the project's node_modules), served to its frame, rebuilt when
 * its file changes; an HTML page served with its files; and what's refused.
 */

const REACT = path.resolve('packages/mac/node_modules');
const haveReact = existsSync(path.join(REACT, 'react')) && existsSync(path.join(REACT, 'react-dom'));

const CARD = `import './card.css';
type Plan = 'free' | 'pro';
export interface CardProps { plan: Plan; price: number; onSelect: (p: Plan) => void }
export default function Card({ plan, price = 24, onSelect }: CardProps) {
  return <button className="card" onClick={() => onSelect(plan)}>{plan} {price}</button>;
}
`;

let root: string;
let manager: PreviewManager;
const ok = (r: PreviewResult) => {
  if (!r.ok) throw new Error(`${r.kind}: ${r.title}`);
  return r;
};
const base = (url: string): string => url.split('?')[0]!;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'beluga-preview-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'site', 'img'), { recursive: true });
  if (haveReact) symlinkSync(REACT, path.join(root, 'node_modules'));
  writeFileSync(path.join(root, 'src', 'Card.tsx'), CARD);
  writeFileSync(path.join(root, 'src', 'card.css'), '.card { border-radius: 12px }');
  writeFileSync(path.join(root, 'src', 'Broken.tsx'), "import { x } from './Nowhere';\nexport default function Broken() { return <b>{x}</b> }\n");
  writeFileSync(path.join(root, 'src', 'util.ts'), 'export const add = (a: number, b: number) => a + b;\n');
  writeFileSync(path.join(root, 'site', 'index.html'), '<!doctype html><html><body><h1>Hi</h1><img src="img/a.svg"></body></html>');
  writeFileSync(path.join(root, 'site', 'img', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(path.join(root, 'site', '.secret'), 'nope');
  writeFileSync(path.join(root, '.env'), 'TOKEN=1');
  // A file next to the worktree, and components that try to read it, or a secret inside it.
  writeFileSync(path.join(root, '..', `${path.basename(root)}-outside.json`), '{"key": "not yours"}');
  writeFileSync(path.join(root, 'src', 'Reach.tsx'), `import k from '../../${path.basename(root)}-outside.json';\nexport default function Reach() { return <b>{String(k)}</b> }\n`);
  writeFileSync(path.join(root, 'src', 'Secret.tsx'), "import t from '../.env';\nexport default function Secret() { return <b>{String(t)}</b> }\n");
  // Any free port: a running Beluga may hold the usual one.
  manager = new PreviewManager(new PreviewServer(0), { idleMs: 0 });
});

afterAll(async () => {
  await manager.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(path.join(root, '..', `${path.basename(root)}-outside.json`), { force: true });
});

describe('what a preview may read', () => {
  it('only files inside the worktree, never secrets', async () => {
    expect(await worktreeFile(root, 'src/Card.tsx')).toMatchObject({ rel: 'src/Card.tsx' });
    expect(await worktreeFile(root, '../outside.tsx')).toMatchObject({ ok: false, kind: 'missing' });
    expect(await worktreeFile(root, '.env')).toMatchObject({ ok: false, kind: 'missing', title: '.env may hold secrets' });
    expect(await worktreeFile(root, 'src/Nope.tsx')).toMatchObject({ ok: false, kind: 'missing' });
  });

  it('says plainly when a file has no component', async () => {
    expect(await manager.open(root, { target: { kind: 'component', file: 'src/util.ts' } })).toMatchObject({ ok: false, kind: 'no-component' });
    expect(await manager.open(root, { target: { kind: 'component', file: 'src/Card.tsx', export: 'Other' } })).toMatchObject({ ok: false, kind: 'no-component', title: 'Card.tsx doesn’t export Other' });
  });

  it('says nothing answers at a dev server that isn’t running', async () => {
    expect(await manager.open(root, { target: { kind: 'url', url: 'http://127.0.0.1:9/' } })).toMatchObject({ ok: false, kind: 'not-running' });
  });
});

describe.skipIf(!haveReact)('a component, built and served', () => {
  it('builds it with its props filled in from the types', async () => {
    const out = ok(await manager.open(root, { target: { kind: 'component', file: 'src/Card.tsx' }, props: { plan: 'pro' } }));
    expect(out.kind).toBe('component');
    expect(out.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}\/\?v=1$/);
    expect(out.component?.name).toBe('Card');
    expect(out.component?.props.map((p) => p.name)).toEqual(['plan', 'price', 'onSelect']);
    expect(out.props).toMatchObject({ plan: 'pro', price: 24, onSelect: { $beluga: 'fn', name: 'onSelect' } });
    // The same preview again is the same build.
    expect(ok(await manager.open(root, { target: { kind: 'component', file: 'src/Card.tsx' } })).id).toBe(out.id);
  });

  it('serves the page, the runtime, the bundle and its CSS, framed only by Beluga', async () => {
    const out = ok(await manager.open(root, { target: { kind: 'component', file: 'src/Card.tsx' } }));
    const page = await fetch(base(out.url));
    const html = await page.text();
    expect(page.headers.get('content-security-policy')).toMatch(/script-src 'self';.*frame-ancestors tauri:\/\/localhost/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('<script src="bundle.js?v=1"></script>');
    expect(html).toContain('"price":24');
    const bundle = await (await fetch(`${base(out.url)}bundle.js`)).text();
    expect(bundle).toContain('__belugaPreview.mount');
    expect(await (await fetch(`${base(out.url)}bundle.css`)).text()).toContain('border-radius:12px');
    expect((await fetch(`${base(out.url)}runtime.js`)).headers.get('content-type')).toContain('javascript');
    expect(await (await fetch(`${base(out.url)}tools.js`)).text()).toContain('__belugaTools');
    // Sample pictures are drawn by the server, from their short names.
    const picture = await fetch(`${base(out.url)}picture/1-LP.svg`);
    expect(picture.headers.get('content-type')).toBe('image/svg+xml');
    expect(await picture.text()).toContain('>LP</text>');
    expect((await fetch(`${base(out.url)}../`)).status).toBe(404);
    // Another host name (DNS rebinding) is refused.
    const port = Number(new URL(out.url).port);
    const status = await new Promise<number | undefined>((resolve) => request({ host: '127.0.0.1', port, path: `/p/${out.id}/`, headers: { host: `evil.example:${port}` } }, (res) => (res.resume(), resolve(res.statusCode))).end());
    expect(status).toBe(421);
  });

  it('tells the frame when the file changes, with the new build', async () => {
    const out = ok(await manager.open(root, { target: { kind: 'component', file: 'src/Card.tsx' } }));
    const res = await fetch(`${base(out.url)}events`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    // One read at a time: a read left behind by a timeout would swallow its chunk.
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
    const next = async (want: RegExp): Promise<void> => {
      const until = Date.now() + 8000;
      while (!want.test(seen) && Date.now() < until) {
        pending ??= reader.read();
        const got = await Promise.race([pending, new Promise<undefined>((r) => setTimeout(() => r(undefined), 250))]);
        if (!got) continue;
        pending = undefined;
        if (got.value) seen += decoder.decode(got.value);
        if (got.done) return;
      }
    };
    await next(/data: \{"v":1\}/);
    expect(seen).toContain('data: {"v":1}');
    // Let the watcher settle before the change.
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(path.join(root, 'src', 'Card.tsx'), CARD.replace('{plan} {price}', '{plan} costs {price}'));
    await next(/"v":2/);
    expect(seen).toContain('"v":2');
    await reader.cancel();
    const bundle = await (await fetch(`${base(out.url)}bundle.js`)).text();
    expect(bundle).toContain('costs');
  });

  it('words a build that fails, and keeps the details for your agent', async () => {
    const out = await manager.open(root, { target: { kind: 'component', file: 'src/Broken.tsx' } });
    expect(out).toMatchObject({ ok: false, kind: 'missing-import', title: 'Broken.tsx imports a file that isn’t there' });
    expect(out.ok ? '' : out.forClaude).toContain('./Nowhere');
  });

  it('never reads a file outside the worktree, nor a secret in it, through the component’s imports', async () => {
    const reach = await manager.open(root, { target: { kind: 'component', file: 'src/Reach.tsx' } });
    expect(reach).toMatchObject({ ok: false, kind: 'build', title: 'Reach.tsx reads a file from outside this worktree' });
    expect(await manager.open(root, { target: { kind: 'component', file: 'src/Secret.tsx' } })).toMatchObject({ ok: false, title: 'Secret.tsx reads a file from outside this worktree' });
  });

  it('builds a preview once when two places open it at the same moment', async () => {
    writeFileSync(path.join(root, 'src', 'Twice.tsx'), 'export default function Twice() { return <i>twice</i> }\n');
    const [a, b] = await Promise.all([manager.open(root, { target: { kind: 'component', file: 'src/Twice.tsx' } }), manager.open(root, { target: { kind: 'component', file: 'src/Twice.tsx' } })]);
    expect(ok(a).id).toBe(ok(b).id);
  });

  it('answers a request it can’t read with a 400, and keeps going', async () => {
    const out = ok(await manager.open(root, { target: { kind: 'component', file: 'src/Card.tsx' } }));
    const port = Number(new URL(out.url).port);
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => socket.end('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
      let text = '';
      socket.on('data', (d) => (text += d.toString()));
      socket.on('close', () => resolve(text));
      socket.on('error', () => resolve(text));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 (400)/);
    expect((await fetch(base(out.url))).status).toBe(200);
  });

  it('lets go of previews nobody is looking at', async () => {
    // The frame's events stream closing reaches the server a moment later.
    await new Promise((r) => setTimeout(r, 200));
    const before = manager.size;
    expect(before).toBeGreaterThan(0);
    await manager.sweep(Date.now() + 1000);
    expect(manager.size).toBe(0);
  });
});

describe('an HTML page and the files next to it', () => {
  it('is served with a reload script, its pictures, and nothing else', async () => {
    const out = ok(await manager.open(root, { target: { kind: 'html', file: 'site/index.html' } }));
    const page = await fetch(out.url);
    const html = await page.text();
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('<script src="__beluga/reload.js" data-events="events"></script></body>');
    expect(page.headers.get('content-security-policy')).toMatch(/frame-ancestors/);
    expect((await fetch(`${out.url}img/a.svg`)).headers.get('content-type')).toBe('image/svg+xml');
    expect((await fetch(`${out.url}.secret`)).status).toBe(404);
    expect((await fetch(`${out.url}..%2F.env`)).status).toBe(404);
    expect((await fetch(`${out.url}..%2Fsrc%2FCard.tsx`)).status).toBe(200);
  });
});

describe('the preview API', () => {
  const session = (experiments: string[], folder?: string) => ({ store: { getState: () => ({ prefs: { experiments } }) }, workbench: { folderOf: () => folder } }) as unknown as Session;

  it('refuses while the experiment is off, and for a worktree that’s gone', async () => {
    expect(await PREVIEW_HANDLERS['preview.open'](session([], root), 'ws', { target: { kind: 'component', file: 'src/Card.tsx' } })).toMatchObject({ ok: false, kind: 'off' });
    expect(await PREVIEW_HANDLERS['preview.open'](session(['previews']), 'ws', { target: { kind: 'component', file: 'src/Card.tsx' } })).toMatchObject({ ok: false, kind: 'missing' });
  });

  it('saves a picture in the worktree’s scratch folder, and the newest one per preview for the phone', async () => {
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a png')]);
    const png = `data:image/png;base64,${bytes.toString('base64')}`;
    expect(await PREVIEW_HANDLERS['preview.snapshot'](session([], root), 'ws', { target: { kind: 'component', file: 'src/Card.tsx' }, name: 'Card', png })).toMatchObject({ ok: false, kind: 'off' });
    const saved = await PREVIEW_HANDLERS['preview.snapshot'](session(['previews'], root), 'ws', { target: { kind: 'component', file: 'src/Card.tsx' }, name: 'Card · Card.tsx', png });
    expect(saved).toMatchObject({ ok: true, path: expect.stringMatching(/^\.beluga\/scratch\/previews\/Card-Card\.tsx \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png$/) });
    const still = await PREVIEW_HANDLERS['preview.snapshot'](session(['previews'], root), 'ws', { target: { kind: 'component', file: 'src/Card.tsx' }, name: 'Card', png, still: true });
    expect(still).toMatchObject({ ok: true, path: '.beluga/scratch/previews/src_Card.tsx.png' });
    expect(readFileSync(path.join(root, '.beluga', 'scratch', 'previews', 'src_Card.tsx.png')).equals(bytes)).toBe(true);
    // Not a PNG: refused.
    const fake = `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}`;
    expect(await PREVIEW_HANDLERS['preview.snapshot'](session(['previews'], root), 'ws', { target: { kind: 'component', file: 'src/Card.tsx' }, name: 'Card', png: fake })).toMatchObject({ ok: false, title: 'That isn’t a picture' });
    // A link where the picture goes is never written through.
    const victim = path.join(root, '..', `${path.basename(root)}-victim.txt`);
    writeFileSync(victim, 'mine');
    symlinkSync(victim, path.join(root, '.beluga', 'scratch', 'previews', 'src_Linked.tsx.png'));
    expect(await PREVIEW_HANDLERS['preview.snapshot'](session(['previews'], root), 'ws', { target: { kind: 'component', file: 'src/Linked.tsx' }, name: 'Linked', png, still: true })).toMatchObject({ ok: false });
    expect(readFileSync(victim, 'utf8')).toBe('mine');
    rmSync(victim);
    expect(await PREVIEW_HANDLERS['preview.snapshot'](session(['previews'], root), 'ws', { target: { kind: 'component', file: 'src/Card.tsx' }, name: 'Card', png: 'data:text/html;base64,PGI+' })).toMatchObject({ ok: false });
  });

  it('never frames a page off this computer', async () => {
    expect(await PREVIEW_HANDLERS['preview.open'](session(['previews'], root), 'ws', { target: { kind: 'url', url: 'https://example.com/' } })).toMatchObject({ ok: false, kind: 'elsewhere' });
  });
});
