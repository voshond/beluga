import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import { isSecretPath } from '../core/shares.js';
import { type PreviewProblem, type PreviewResult, problem } from '../shared/preview/opened.js';
import { pickComponent } from '../shared/preview/props.js';
import { componentsOf, frameworkOf } from '../shared/preview/components.js';
import { findStorybookPreview, findWrapper, packageMajor, sourceLoader, tailwindEntry } from './project.js';
import type { PreviewTarget } from '../shared/preview/ref.js';
import { PICTURE, placeholderSvg, sampleProps } from '../shared/preview/samples.js';
import type { ComponentInfo } from '../shared/preview/shape.js';
import { type Bundle, type Bundler, makeBundler, stopEsbuild } from './bundle.js';
import { stopCompilers } from './compilers.js';
import { RELOAD_JS, RUNTIME_CSS, RUNTIME_JS } from './runtime.js';
import { TOOLS_JS } from './tools.js';
import { previewsStarted } from './off.js';
import { COMPONENT_CSP, PAGE_CSP, PreviewServer, pageFile, send, sendFile } from './server.js';

/**
 * Live previews (Settings › Experimental): each component or page that's on screen somewhere is
 * built once, served to its frame, and rebuilt when its files change, the frame told at once (a
 * server-sent event) so it swaps the new build in with the same props. Nothing runs for a preview
 * nobody is looking at: one with no frame open for IDLE_MS is let go (its build, its watcher), and
 * at most MAX_LIVE are kept.
 */

export interface OpenSpec {
  readonly target: PreviewTarget;
  /** Props Claude chose; the rest are filled in from the types. */
  readonly props?: Readonly<Record<string, unknown>>;
  /** A stylesheet in the worktree to bundle with it. */
  readonly css?: string;
  /** A wrapper in the worktree that gives the component its providers (else the project's preview-wrapper file). */
  readonly wrap?: string;
}

const IDLE_MS = 2 * 60_000;
const MAX_LIVE = 6;
const SWEEP_MS = 30_000;
const KEEPALIVE_MS = 25_000;
/** A save is often several writes: one rebuild after they settle. */
const SETTLE_MS = 90;
const MAX_SOURCE = 2 * 1024 * 1024;
const PROBE_MS = 2_500;

/** A path in the worktree, checked: inside it (links too), not a secret, a file. */
export async function worktreeFile(root: string, rel: string): Promise<{ readonly abs: string; readonly rel: string } | PreviewProblem> {
  const name = rel.split('/').pop() ?? rel;
  const gone = problem('missing', `${name} isn’t in this worktree`, 'It may have moved, or not been written yet.');
  const base = await realpath(root).catch(() => undefined);
  if (!base) return problem('missing', 'This worktree is gone', 'Open the preview from a worktree that’s still here.');
  const abs = await realpath(path.resolve(base, rel)).catch(() => undefined);
  if (!abs) return gone;
  const inside = path.relative(base, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || inside.split(path.sep).includes('.git')) return gone;
  if (isSecretPath(inside)) return problem('missing', `${name} may hold secrets`, 'Previews never read files like that.');
  const info = await stat(abs).catch(() => undefined);
  if (!info?.isFile()) return gone;
  return { abs, rel: inside.split(path.sep).join('/') };
}

const isProblem = (x: unknown): x is PreviewProblem => Boolean(x && typeof x === 'object' && (x as { ok?: unknown }).ok === false);

/** JSON for an inline <script type="application/json">: nothing in it can close the tag. */
const inlineJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);

abstract class Live {
  readonly id = randomBytes(16).toString('hex');
  version = 1;
  lastUsed = Date.now();
  protected readonly clients = new Set<ServerResponse>();
  protected watcher?: FSWatcher;
  private settle?: NodeJS.Timeout;
  /** Let go of: nothing it does after this may start anything again. */
  protected disposed = false;

  constructor(readonly key: string, readonly root: string) {}

  get watched(): boolean {
    return this.clients.size > 0;
  }

  /** The frame's events: the version now, then each new one (or why the newest build failed). */
  protected events(req: IncomingMessage, res: ServerResponse): true {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
    res.write(`retry: 1500\ndata: ${JSON.stringify({ v: this.version })}\n\n`);
    this.clients.add(res);
    this.lastUsed = Date.now();
    req.on('close', () => {
      this.clients.delete(res);
      this.lastUsed = Date.now();
    });
    return true;
  }

  protected tell(message: Readonly<Record<string, unknown>>): void {
    const line = `data: ${JSON.stringify(message)}\n\n`;
    for (const res of this.clients) res.write(line);
  }

  keepAlive(): void {
    for (const res of this.clients) res.write(':\n\n');
  }

  protected watch(paths: readonly string[], options: { depth?: number } = {}): void {
    if (this.disposed) return;
    if (!this.watcher) {
      this.watcher = watch([...paths], { ignoreInitial: true, ignored: (p) => /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(p), ...options });
      this.watcher.on('all', () => {
        clearTimeout(this.settle);
        this.settle = setTimeout(() => void this.changed().catch(() => undefined), SETTLE_MS);
      });
      this.watcher.on('error', () => undefined);
      return;
    }
    this.watcher.add([...paths]);
  }

  protected abstract changed(): Promise<void>;
  abstract serve(rest: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> | boolean;

  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.settle);
    for (const res of this.clients) res.end();
    this.clients.clear();
    await this.watcher?.close().catch(() => undefined);
    this.watcher = undefined;
  }
}

/** A component, built with esbuild. */
class LiveComponent extends Live {
  bundle?: Bundle;
  problem?: PreviewProblem;
  /** The props the page starts with (the newest open's). */
  props: Readonly<Record<string, unknown>> = {};
  private building?: Promise<void>;
  private inputs = new Set<string>();

  constructor(key: string, root: string, readonly rel: string, private readonly bundler: Bundler) {
    super(key, root);
  }

  /** Build now (one at a time; a change during a build builds again after it). */
  rebuild(): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.disposed) return;
      const out = await this.bundler.build();
      if (this.disposed) return;
      if (out.ok) {
        const first = !this.bundle;
        this.bundle = out.bundle;
        this.problem = undefined;
        if (!first) this.version++;
        const fresh = out.bundle.inputs.filter((p) => !this.inputs.has(p));
        for (const p of fresh) this.inputs.add(p);
        if (fresh.length) this.watch(fresh);
        this.tell({ v: this.version });
      } else {
        this.problem = out.problem;
        // The file to watch even when it never built: fixing it brings the preview back.
        if (!this.inputs.size) {
          const file = path.resolve(this.root, this.rel);
          this.inputs.add(file);
          this.watch([file]);
        }
        this.tell({ v: this.version, problem: out.problem });
      }
    };
    // Never rejects: a watcher or a frame that went away mid-build is no reason to fail the next one.
    const next = (this.building ?? Promise.resolve()).then(run).catch(() => undefined);
    this.building = next.then(() => {
      if (this.building === next) this.building = undefined;
    });
    return next;
  }

  /** The newest build is done (or there's none under way). */
  async settled(): Promise<void> {
    await this.building;
  }

  protected changed(): Promise<void> {
    return this.rebuild();
  }

  serve(rest: string, req: IncomingMessage, res: ServerResponse): boolean {
    const file = rest.split('?')[0] ?? '';
    if (file === '' || file === 'index.html') {
      send(res, 200, 'text/html; charset=utf-8', this.page());
      return true;
    }
    if (file === 'runtime.js') return send(res, 200, 'text/javascript; charset=utf-8', RUNTIME_JS), true;
    if (file === 'runtime.css') return send(res, 200, 'text/css; charset=utf-8', RUNTIME_CSS), true;
    if (file === 'tools.js') return send(res, 200, 'text/javascript; charset=utf-8', TOOLS_JS), true;
    if (file === 'bundle.js') return send(res, 200, 'text/javascript; charset=utf-8', this.bundle?.js ?? ''), true;
    if (file === 'bundle.css') return send(res, 200, 'text/css; charset=utf-8', this.bundle?.css ?? ''), true;
    if (file === 'events') return this.events(req, res);
    // A sample picture (shared/preview/samples.ts samplePicture), drawn here.
    const picture = PICTURE.exec(file);
    if (picture) return send(res, 200, 'image/svg+xml', placeholderSvg(Number(picture[1]), picture[2])), true;
    return false;
  }

  private page(): string {
    return `<!doctype html><html lang="en" data-v="${this.version}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preview</title><link rel="stylesheet" href="runtime.css"><link id="bundle-css" rel="stylesheet" href="bundle.css?v=${this.version}"></head><body><div id="stage"><div id="root"></div></div><script type="application/json" id="beluga-props">${inlineJson(this.props)}</script><script src="runtime.js"></script><script src="bundle.js?v=${this.version}"></script></body></html>`;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    await this.bundler.dispose();
  }
}

/** An .html file and the files next to it, reloaded when any of them changes. */
class LivePage extends Live {
  constructor(key: string, root: string, private readonly file: string) {
    super(key, root);
    this.watch([path.dirname(file)], { depth: 3 });
  }

  protected changed(): Promise<void> {
    this.version++;
    this.tell({ v: this.version });
    return Promise.resolve();
  }

  async serve(rest: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const name = rest.split('?')[0] ?? '';
    if (name === 'events') return this.events(req, res);
    if (name === '__beluga/reload.js') return send(res, 200, 'text/javascript; charset=utf-8', RELOAD_JS, PAGE_CSP), true;
    const file = name === '' ? this.file : await pageFile(this.root, path.dirname(this.file), name);
    if (!file) return false;
    if (/\.html?$/i.test(file)) {
      const html = await readFile(file, 'utf8');
      const reload = `<script src="__beluga/reload.js" data-events="events"></script>`;
      const body = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${reload}</body>`) : `${html}${reload}`;
      send(res, 200, 'text/html; charset=utf-8', body, PAGE_CSP);
      return true;
    }
    sendFile(res, file, PAGE_CSP);
    return true;
  }
}

/** Whether a page on this computer answers, and lets itself be framed. */
export async function probePage(url: string, fetcher: typeof fetch = fetch): Promise<PreviewProblem | undefined> {
  const where = new URL(url).host;
  try {
    // Not followed: a redirect is an answer (the server runs), and the daemon never fetches where it points.
    const res = await fetcher(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(PROBE_MS) });
    void res.body?.cancel().catch(() => undefined);
    const xfo = res.headers.get('x-frame-options')?.toLowerCase();
    const csp = res.headers.get('content-security-policy')?.toLowerCase() ?? '';
    const ancestors = /frame-ancestors\s+([^;]*)/.exec(csp)?.[1]?.trim();
    if (xfo === 'deny' || xfo === 'sameorigin' || ancestors === "'none'" || ancestors === "'self'") {
      return problem('no-frames', `${where} asks not to be shown inside other apps`, 'Open it in your browser instead, or let your agent allow it while you develop.', `The page ${url} refuses to be framed (x-frame-options: ${xfo ?? 'none'}; frame-ancestors: ${ancestors ?? 'none'}). Beluga's preview frames it from tauri://localhost.`);
    }
    return undefined;
  } catch {
    return problem('not-running', `Nothing answers at ${where} yet`, 'Start the dev server, and the page shows here.', `Nothing answered at ${url}: the dev server isn't running, or runs on another port.`);
  }
}

export class PreviewManager {
  private readonly lives = new Map<string, Live>();
  private readonly byKey = new Map<string, Live>();
  /** Components being set up: a second open of the same one (a chat block and Files) waits for the first. */
  private readonly starting = new Map<string, Promise<LiveComponent>>();
  /** Closed (the experiment turned off, the daemon stopping): nothing starts again. */
  private closed = false;
  private timers?: { sweep: NodeJS.Timeout; alive: NodeJS.Timeout };

  constructor(
    private readonly server = new PreviewServer(),
    private readonly opts: { readonly idleMs?: number; readonly maxLive?: number; readonly fetcher?: typeof fetch } = {},
  ) {}

  /**
   * Where the server listens and the worktrees with a preview live now: on one of your computers,
   * the app forwards that port to the Mac that shows them (src/machines/forward.ts).
   */
  serving(): { readonly port: number; readonly roots: readonly string[] } | undefined {
    const port = this.server.listening;
    if (port === undefined || !this.lives.size) return undefined;
    return { port, roots: [...new Set([...this.lives.values()].map((l) => l.root))] };
  }

  /** A preview of `spec`, in the worktree at `root`: built (or the one built already) and where its frame loads it. */
  async open(root: string, spec: OpenSpec): Promise<PreviewResult> {
    if (this.closed) return problem('off', 'Live previews are off', 'Turn them on in Settings › Experimental.');
    const t = spec.target;
    if (t.kind === 'url') {
      const trouble = await probePage(t.url, this.opts.fetcher);
      return trouble ?? { ok: true, id: t.url, url: t.url, kind: 'url', version: 1 };
    }
    const found = await worktreeFile(root, t.file);
    if (isProblem(found)) return found;
    this.startTimers();
    if (t.kind === 'html') {
      const key = `html\0${found.abs}`;
      const live = (this.byKey.get(key) as LivePage | undefined) ?? this.keep(new LivePage(key, root, found.abs));
      live.lastUsed = Date.now();
      if (this.closed) return problem('off', 'Live previews are off', 'Turn them on in Settings › Experimental.');
      return { ok: true, id: live.id, url: `${await this.server.origin()}/p/${live.id}/`, kind: 'html', version: live.version };
    }
    const info = await stat(found.abs);
    if (info.size > MAX_SOURCE) return problem('build', `${found.rel.split('/').pop()} is too big to preview`, 'Previews are for components, not whole bundles.');
    const framework = frameworkOf(found.abs);
    // Types imported from the project's other files are followed (inside the worktree only).
    const components = componentsOf(found.abs, await readFile(found.abs, 'utf8'), sourceLoader(root, found.abs));
    const comp = pickComponent(components, t.export);
    if (!comp) return noComponent(found.rel, t.export, components);
    const css: string[] = [];
    if (spec.css) {
      const sheet = await worktreeFile(root, spec.css);
      if (!isProblem(sheet)) css.push(sheet.abs);
    }
    // A Tailwind project's stylesheet comes along, so its classes are styled as in the app.
    const tw = tailwindEntry(root);
    if (tw && !css.includes(tw)) css.push(tw);
    const react = framework === 'react';
    const wrapper = react ? findWrapper(root, spec.wrap) : undefined;
    const storybook = react ? findStorybookPreview(root) : undefined;
    const entry = { framework, pick: comp.isDefault ? 'default' : comp.name, css, ...(wrapper ? { wrapper } : {}), ...(storybook ? { storybook } : {}), ...(framework === 'svelte' ? { svelte: packageMajor(root, 'svelte') ?? 5 } : {}) };
    const key = `component\0${found.abs}\0${comp.name}\0${css.join('\0')}\0${wrapper ?? ''}`;
    let live = this.byKey.get(key) as LiveComponent | undefined;
    if (!live) {
      let start = this.starting.get(key);
      if (!start) {
        start = (async () => {
          const bundler = await makeBundler(root, found.abs, found.rel, entry);
          const made = this.keep(new LiveComponent(key, root, found.rel, bundler));
          await made.rebuild();
          return made;
        })().finally(() => this.starting.delete(key));
        this.starting.set(key, start);
      }
      live = await start;
    }
    await live.settled();
    // Closed meanwhile: nothing is handed out (handing out an address would start the server again).
    if (this.closed) return problem('off', 'Live previews are off', 'Turn them on in Settings › Experimental.');
    live.lastUsed = Date.now();
    live.props = sampleProps(comp.props, spec.props);
    if (!live.bundle && live.problem) return live.problem;
    return {
      ok: true,
      id: live.id,
      url: `${await this.server.origin()}/p/${live.id}/?v=${live.version}`,
      kind: 'component',
      version: live.version,
      component: { name: comp.name, exports: components.map((c) => c.name), props: comp.props, framework, ...(wrapper ? { wrapper: path.relative(realpathSync(root), wrapper) } : {}) },
      props: live.props,
      // Every component of the file with its own samples, for Show All (React: one build has them all).
      ...(react && components.length > 1 ? { gallery: components.map((c) => ({ name: c.isDefault ? 'default' : c.name, label: c.name, props: sampleProps(c.props) })) } : {}),
    };
  }

  private keep<T extends Live>(live: T): T {
    // Closed while it was being made: let go at once, never kept.
    if (this.closed) {
      void live.dispose();
      return live;
    }
    this.lives.set(live.id, live);
    this.byKey.set(live.key, live);
    this.server.add(live.id, live);
    // Too many: the one looked at longest ago goes (never one a frame shows).
    const idle = [...this.lives.values()].filter((l) => !l.watched && l !== live).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.lives.size > (this.opts.maxLive ?? MAX_LIVE) && idle.length) void this.drop(idle.shift()!);
    return live;
  }

  private async drop(live: Live): Promise<void> {
    this.lives.delete(live.id);
    if (this.byKey.get(live.key) === live) this.byKey.delete(live.key);
    this.server.remove(live.id);
    await live.dispose();
  }

  /** Let go of previews nobody has looked at for a while. */
  async sweep(now = Date.now()): Promise<void> {
    const idleMs = this.opts.idleMs ?? IDLE_MS;
    for (const live of [...this.lives.values()]) if (!live.watched && now - live.lastUsed > idleMs) await this.drop(live);
    if (!this.lives.size && !this.starting.size) await this.rest();
  }

  /** Nothing left to show: the server closes and esbuild's helper stops, until the next preview. */
  private async rest(): Promise<void> {
    this.stopTimers();
    this.server.close();
    stopCompilers();
    await stopEsbuild();
  }

  get size(): number {
    return this.lives.size;
  }

  private startTimers(): void {
    if (this.timers) return;
    const sweep = setInterval(() => void this.sweep(), SWEEP_MS);
    const alive = setInterval(() => {
      for (const live of this.lives.values()) live.keepAlive();
    }, KEEPALIVE_MS);
    sweep.unref();
    alive.unref();
    this.timers = { sweep, alive };
  }

  private stopTimers(): void {
    if (!this.timers) return;
    clearInterval(this.timers.sweep);
    clearInterval(this.timers.alive);
    this.timers = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    // Builds under way finish first (keep() lets them go), then everything is let go.
    await Promise.allSettled([...this.starting.values()]);
    for (const live of [...this.lives.values()]) await this.drop(live);
    await this.rest();
  }
}

function noComponent(rel: string, wanted: string | undefined, components: readonly ComponentInfo[]): PreviewProblem {
  const name = rel.split('/').pop() ?? rel;
  if (wanted && components.length) return problem('no-component', `${name} doesn’t export ${wanted}`, `It has ${components.map((c) => c.name).join(', ')}.`, `The preview asked for the export ${wanted} of ${rel}, which exports ${components.map((c) => c.name).join(', ')}.`);
  return problem('no-component', `There’s no component to show in ${name}`, 'A preview draws a React component the file exports.', `The preview found no exported React component in ${rel} (a capitalized function or class that is exported).`);
}

let shared: PreviewManager | undefined;

/** The daemon's previews, made the first time one is opened (and closable from preview/off.ts). */
export function previews(): PreviewManager {
  if (!shared) {
    const made = new PreviewManager();
    shared = made;
    previewsStarted(async () => {
      if (shared === made) shared = undefined;
      await made.close();
    });
  }
  return shared;
}
