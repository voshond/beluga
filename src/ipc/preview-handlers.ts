import type { Session } from '../core/session.js';
import { experimentOn } from '../shared/experiments.js';
import { constants } from 'node:fs';
import { lstat, mkdir, open as openFile } from 'node:fs/promises';
import path from 'node:path';
import { type PreviewProblem, type PreviewResult, problem } from '../shared/preview/opened.js';
import { STILLS_DIR, loopbackUrl, stillName } from '../shared/preview/ref.js';
import { ensureScratch } from '../workspaces/scratch.js';
import type { Args, Method } from './api.js';

/** What each `preview.*` method does (see preview-api.ts). */

type PreviewMethod = Extract<Method, `preview.${string}`>;
type PreviewHandlers = { readonly [M in PreviewMethod]: (s: Session, ...args: Args<M>) => unknown };

async function open(s: Session, wsId: string, spec: Args<'preview.open'>[1]): Promise<PreviewResult> {
  if (!experimentOn(s.store.getState().prefs.experiments, 'previews')) return problem('off', 'Live previews are off', 'They’re an experimental feature: turn them on in Settings › Experimental.');
  // Loaded only now: with the experiment off, nothing of previews is ever loaded.
  const { previews } = await import('../preview/manager.js');
  // Turned off while it loaded: still off.
  if (!experimentOn(s.store.getState().prefs.experiments, 'previews')) return problem('off', 'Live previews are off', 'They’re an experimental feature: turn them on in Settings › Experimental.');
  const root = s.workbench?.folderOf(wsId);
  if (!root) return problem('missing', 'This worktree is gone', 'Previews show for worktrees that are still here.');
  const target = spec.target;
  // Only pages on this computer: a preview never frames the open web into the chat.
  if (target.kind === 'url') {
    const url = loopbackUrl(target.url);
    if (!url) return problem('elsewhere', 'Only pages on this computer show here', 'Open that address in your browser.');
    return previews().open(root, { target: { kind: 'url', url } });
  }
  const t = target.kind === 'component' ? { kind: 'component' as const, file: target.file, ...(target.export ? { export: target.export } : {}) } : { kind: 'html' as const, file: target.file };
  return previews().open(root, { target: t, ...(spec.props ? { props: spec.props } : {}), ...(spec.css ? { css: spec.css } : {}), ...(spec.wrap ? { wrap: spec.wrap } : {}) });
}

const PNG = 'data:image/png;base64,';
/** What every PNG starts with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A file name's safe part ("PriceCard · PriceCard.tsx" → "PriceCard-PriceCard.tsx"). */
const slug = (name: string): string => name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'preview';

/** "2026-11-08 13.05.22", for a picture's name. */
const stamp = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${[d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('.')}`;

async function snapshot(s: Session, wsId: string, shot: Args<'preview.snapshot'>[1]): Promise<{ readonly ok: true; readonly path: string } | PreviewProblem> {
  if (!experimentOn(s.store.getState().prefs.experiments, 'previews')) return problem('off', 'Live previews are off', 'Turn them on in Settings › Experimental.');
  const root = s.workbench?.folderOf(wsId);
  if (!root) return problem('missing', 'This worktree is gone', 'Pictures are saved in a worktree that’s still here.');
  if (!shot.png.startsWith(PNG)) return problem('build', 'That isn’t a picture', 'Try Save as Picture again.');
  const scratch = await ensureScratch(root);
  if (!scratch) return problem('missing', 'The scratch folder can’t be made here', 'Beluga keeps pictures in the worktree’s .beluga/scratch folder.');
  const bytes = Buffer.from(shot.png.slice(PNG.length), 'base64');
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) return problem('build', 'That isn’t a picture', 'Try Save as Picture again.');
  // The folder, never a link out of the worktree; the file written only where it is (never through a link).
  const dir = path.join(scratch, STILLS_DIR);
  const there = await lstat(dir).catch(() => undefined);
  if (there && !there.isDirectory()) return problem('missing', 'Pictures can’t be saved here', 'Something other than a folder is where they go.');
  if (!there) await mkdir(dir);
  const t = shot.target;
  const target = t.kind === 'url' ? { kind: 'url' as const, url: t.url } : { kind: t.kind, file: t.file };
  const name = shot.still ? stillName(target) : `${slug(shot.name)} ${stamp()}.png`;
  const file = path.join(dir, name);
  const was = await lstat(file).catch(() => undefined);
  if (was && !was.isFile()) return problem('missing', 'Pictures can’t be saved here', 'Something other than a picture has its name.');
  const handle = await openFile(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return { ok: true, path: path.relative(root, file).split(path.sep).join('/') };
}

export const PREVIEW_HANDLERS = {
  'preview.open': (s, wsId, spec) => open(s, wsId, spec),
  'preview.snapshot': (s, wsId, shot) => snapshot(s, wsId, shot),
} satisfies PreviewHandlers;
