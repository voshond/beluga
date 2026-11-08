/**
 * Saving the image of your stats (the Usage tab's Share): the Mac draws it, you pick where in the
 * Save panel, and the daemon writes it there. Only a PNG, only to an absolute path ending in .png.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Write `png` (base64) to `to` → where it went. Throws a plain reason when it isn't a PNG or the path won't do. */
export async function saveStatsImage(png: string, to: string): Promise<string> {
  if (!path.isAbsolute(to) || to.includes('\0') || path.extname(to).toLowerCase() !== '.png') throw new Error('Save it as a .png file');
  const bytes = Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64');
  if (bytes.length < PNG.length || !bytes.subarray(0, PNG.length).equals(PNG)) throw new Error('That isn’t a PNG image');
  const file = path.resolve(to);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { mode: 0o644 });
  return file;
}
