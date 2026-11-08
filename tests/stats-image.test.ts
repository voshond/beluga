import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveStatsImage } from '../src/core/stats/image.js';
import { parseArgs } from '../src/ipc/api.js';

/** Sharing your stats (BLG-763): the Mac draws the picture, the daemon writes it where you chose. */

// The smallest PNG: its signature and an IHDR's start are enough to be one here.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('0000000d49484452', 'hex')]).toString('base64');

describe('saving the picture of your stats', () => {
  it('writes a PNG where you chose, folders and all', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'stats-image-'));
    const to = path.join(dir, 'shared', 'My Beluga stats.png');
    expect(await saveStatsImage(`data:image/png;base64,${PNG}`, to)).toBe(to);
    expect(readFileSync(to).subarray(0, 4).toString('hex')).toBe('89504e47');
  });

  it('only writes a PNG, only to an absolute .png path', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'stats-image-'));
    await expect(saveStatsImage(Buffer.from('not a picture at all').toString('base64'), path.join(dir, 'x.png'))).rejects.toThrow(/PNG/);
    await expect(saveStatsImage(PNG, path.join(dir, 'x.sh'))).rejects.toThrow(/\.png/);
    await expect(saveStatsImage(PNG, 'relative/x.png')).rejects.toThrow(/\.png/);
  });

  it('takes a picture and a path from the Mac, nothing else', () => {
    expect(() => parseArgs('stats.saveImage', [PNG, '/tmp/a.png'])).not.toThrow();
    expect(() => parseArgs('stats.saveImage', [PNG])).toThrow();
  });
});
