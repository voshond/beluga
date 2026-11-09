import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { appendFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_UPLOAD_BYTES, type PhoneFrame } from './protocol.js';

/**
 * Photos and files from the phone (the `put` frame): written piece by piece to a file under
 * ~/.beluga/attachments/phone, and named by an `up:` ref once the last piece is in. A ref works
 * only for the phone that sent it, and only through companion.ask / companion.post, which put
 * pictures where pasted images go (attachments.ts) and name other files by their path here.
 */

type Put = Extract<PhoneFrame, { t: 'put' }>;

export interface Upload {
  readonly ref: string;
  readonly path: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  /** The phone that sent it (device id). */
  readonly device: string;
  /** A picture Claude can look at (png, jpeg, gif, webp). */
  readonly image: boolean;
}

/** Uploads kept (the oldest refs go first). */
const MAX_KEPT = 200;
/** Uploads one phone may have half-sent at once. */
const MAX_OPEN = 12;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const IMAGE_MIME: Readonly<Record<string, string>> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/** A file name of ours from the phone's (no folders, no dots first, a sensible extension). */
export function safeUploadName(name: string, mime: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[^\w.() -]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
  const ext = IMAGE_MIME[mime.toLowerCase()];
  return ext && !IMAGE.test(base) ? `${base}${ext}` : base;
}

interface Open {
  readonly device: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly tmp: string;
  received: number;
}

export class Uploads {
  private readonly open = new Map<string, Open>();
  private readonly done = new Map<string, Upload>();

  /** `maxBytes`: the largest file (the phone's 25 MB; your app sends a computer bigger ones, BLG-793). */
  constructor(
    private readonly dir: string,
    private readonly opts: { readonly maxBytes?: number } = {},
  ) {}

  /** One piece: → `{ received }`, or `{ ref }` for the last. Throws for a piece out of order or too much. */
  async piece(device: string, f: Put): Promise<{ received: number } | { ref: string }> {
    const key = `${device}:${f.id}`;
    let up = this.open.get(key);
    if (!up) {
      if (f.off !== 0) throw new Error('That upload has to start at 0');
      if ([...this.open.values()].filter((o) => o.device === device).length >= MAX_OPEN) throw new Error('Too many uploads at once');
      const max = this.opts.maxBytes ?? MAX_UPLOAD_BYTES;
      if (f.size > max) throw new Error(`That file is too big to send (up to ${Math.round(max / 1024 / 1024)} MB)`);
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      up = { device, name: f.name, mime: f.mime, size: f.size, tmp: path.join(this.dir, `.${randomBytes(8).toString('hex')}.part`), received: 0 };
      this.open.set(key, up);
    }
    const bytes = Buffer.from(f.b64, 'base64');
    if (f.off !== up.received || up.received + bytes.length > up.size) {
      this.open.delete(key);
      await rm(up.tmp, { force: true });
      throw new Error('That upload went wrong; send it again');
    }
    // Even nothing: an empty file is still a file.
    await appendFile(up.tmp, bytes, { mode: 0o600 });
    up.received += bytes.length;
    if (!f.eof) return { received: up.received };
    this.open.delete(key);
    if (up.received !== up.size) {
      await rm(up.tmp, { force: true });
      throw new Error('That upload was cut short; send it again');
    }
    const name = safeUploadName(up.name, up.mime);
    const id = randomBytes(12).toString('base64url');
    const file = path.join(this.dir, `${id}-${name}`);
    await rename(up.tmp, file);
    const ref = `up:${id}`;
    this.done.set(ref, { ref, path: file, name, mime: up.mime, size: up.size, device, image: IMAGE.test(name) });
    if (this.done.size > MAX_KEPT) this.done.delete(this.done.keys().next().value as string);
    return { ref };
  }

  /** The uploads behind refs, for the phone that sent them (anything else is refused). */
  async resolve(device: string, refs: readonly string[]): Promise<Upload[]> {
    const out: Upload[] = [];
    for (const ref of refs) {
      const up = this.done.get(ref);
      if (!up || up.device !== device) throw new Error('A file you attached is gone; attach it again');
      await stat(up.path).catch(() => {
        throw new Error(`${up.name} is gone; attach it again`);
      });
      out.push(up);
    }
    return out;
  }

  /** A phone was removed or went away mid-upload: drop what it half-sent. */
  async drop(device: string): Promise<void> {
    for (const [key, up] of [...this.open]) {
      if (up.device !== device) continue;
      this.open.delete(key);
      await rm(up.tmp, { force: true });
    }
  }
}
