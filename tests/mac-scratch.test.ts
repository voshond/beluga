import { describe, expect, it } from 'vitest';
import { HTML_SANDBOX, hasRenderedLook, hasText, isHtmlFile, previewVersion } from '../packages/mac/src/views/reader/reader-model.js';
import { FRESH_MS, atEnd, fileKind, followed, foldersWithFiles, isFresh, isViewable, scratchPlace, scratchState, sortScratch, stepViewable, timeAgo } from '../packages/mac/src/layout/panel/scratch-model.js';

/** The Scratch tab's small decisions: how long ago, what a file is, which one to show. */
describe('Scratch tab model', () => {
  const now = 1_000_000_000;
  it('says how long ago, briefly', () => {
    expect(timeAgo(now - 500, now)).toBe('now');
    expect(timeAgo(now - 12_000, now)).toBe('12s');
    expect(timeAgo(now - 3 * 60_000, now)).toBe('3m');
    expect(timeAgo(now - 5 * 3_600_000, now)).toBe('5h');
    expect(timeAgo(now - 3 * 86_400_000, now)).toBe('3d');
  });

  it('knows a picture, a PDF, JSON, Markdown and the rest', () => {
    expect(fileKind('.context/a.PNG')).toBe('image');
    expect(fileKind('.context/b.pdf')).toBe('pdf');
    expect(fileKind('.beluga/scratch/run.MP4')).toBe('video');
    expect(fileKind('.beluga/scratch/clip.webm')).toBe('video');
    expect(fileKind('.context/r.json')).toBe('json');
    expect(fileKind('.context/notes.md')).toBe('markdown');
    expect(fileKind('.context/log.txt')).toBe('text');
    expect(fileKind('.beluga/scratch/report.HTML')).toBe('html');
    expect(fileKind('.beluga/scratch/page.htm')).toBe('html');
  });

  it('a preview reads a picture again by the version its place gives, else when it was last written (BLG-670)', () => {
    expect(previewVersion(1234, 99)).toBe(1234);
    expect(previewVersion('v2', undefined)).toBe('v2');
    // Changes gives none (its list is the same when a picture is written again): the written time is used.
    expect(previewVersion(undefined, 99)).toBe(99);
    expect(previewVersion({ files: [] }, 99)).toBe(99);
    expect(previewVersion(undefined, undefined)).toBeUndefined();
  });

  it('can look at pictures, videos, PDFs and web pages; the rest is text', () => {
    for (const p of ['a.png', 'b.webm', 'c.pdf', 'd.html', 'e.htm']) expect(isViewable(p)).toBe(true);
    for (const p of ['a.json', 'b.md', 'c.log', 'd.bin']) expect(isViewable(p)).toBe(false);
  });

  // The listing as it comes: newest first.
  const listing = [
    { path: '.beluga/scratch/run.log', size: 1, mtime: 60 },
    { path: '.beluga/scratch/home.png', size: 1, mtime: 50 },
    { path: '.beluga/scratch/api.json', size: 1, mtime: 40 },
    { path: '.beluga/scratch/report.html', size: 1, mtime: 30 },
    { path: '.beluga/scratch/notes.md', size: 1, mtime: 20 },
    { path: '.context/clip.webm', size: 1, mtime: 10 },
  ];
  const names = (fs: readonly { path: string }[]) => fs.map((f) => f.path.split('/').pop());

  it('sorts newest first, or what can be looked at first (each part still newest first)', () => {
    expect(names(sortScratch(listing, 'newest'))).toEqual(['run.log', 'home.png', 'api.json', 'report.html', 'notes.md', 'clip.webm']);
    expect(names(sortScratch([...listing].reverse(), 'newest'))).toEqual(['run.log', 'home.png', 'api.json', 'report.html', 'notes.md', 'clip.webm']);
    expect(names(sortScratch(listing, 'viewable'))).toEqual(['home.png', 'report.html', 'clip.webm', 'run.log', 'api.json', 'notes.md']);
    expect(sortScratch([], 'viewable')).toEqual([]);
  });

  it('steps to the next or previous viewable file in the order shown, over the rest, and stops at the ends', () => {
    const order = sortScratch(listing, 'newest').map((f) => f.path);
    const at = (name: string) => order.find((p) => p.endsWith(`/${name}`));
    // home.png → (api.json skipped) → report.html → (notes.md skipped) → clip.webm → the end.
    expect(stepViewable(order, at('home.png'), 1)).toBe(at('report.html'));
    expect(stepViewable(order, at('report.html'), 1)).toBe(at('clip.webm'));
    expect(stepViewable(order, at('clip.webm'), 1)).toBeUndefined();
    expect(stepViewable(order, at('report.html'), -1)).toBe(at('home.png'));
    // Nothing viewable before the first picture (run.log is text): no wrapping round.
    expect(stepViewable(order, at('home.png'), -1)).toBeUndefined();
    // From a file that's no longer listed: from that end.
    expect(stepViewable(order, 'gone.png', 1)).toBe(at('home.png'));
    expect(stepViewable(order, undefined, -1)).toBe(at('clip.webm'));
    // In the viewable-first order it follows that order instead.
    const viewable = sortScratch(listing, 'viewable').map((f) => f.path);
    expect(stepViewable(viewable, at('clip.webm'), -1)).toBe(at('report.html'));
    expect(stepViewable(viewable, at('clip.webm'), 1)).toBeUndefined();
  });

  it('marks what was just written', () => {
    expect(isFresh(now - FRESH_MS + 1, now)).toBe(true);
    expect(isFresh(now - FRESH_MS - 1, now)).toBe(false);
  });

  it('follows the newest file, or keeps the one you picked while it’s there', () => {
    const files = [{ path: 'b', size: 1, mtime: 2 }, { path: 'a', size: 1, mtime: 1 }];
    expect(followed(files, true, 'a')).toBe('b');
    expect(followed(files, false, 'a')).toBe('a');
    expect(followed(files, false, 'gone')).toBe('b');
    expect(followed([], true, undefined)).toBeUndefined();
  });

  it('follows a file’s end once scrolled to it, not while up the file or when it all fits', () => {
    expect(atEnd({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(atEnd({ scrollTop: 595, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(atEnd({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
    expect(atEnd({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(false);
  });

  const roots = ['.klaud/scratch', '.context'];
  it('says which shown folder a file is in, the folders under it, and its name', () => {
    expect(scratchPlace('.klaud/scratch/shots/a.png', roots)).toEqual({ root: '.klaud/scratch', dir: 'shots', name: 'a.png' });
    expect(scratchPlace('.context/b.png', roots)).toEqual({ root: '.context', dir: '', name: 'b.png' });
    expect(scratchPlace('.context/x/y/c.md', roots)).toEqual({ root: '.context', dir: 'x/y', name: 'c.md' });
  });

  it('names only the folders that have files, in their order', () => {
    expect(foldersWithFiles([{ path: '.context/a', size: 1, mtime: 1 }], roots)).toEqual(['.context']);
    expect(foldersWithFiles([{ path: '.context/a', size: 1, mtime: 2 }, { path: '.klaud/scratch/b', size: 1, mtime: 1 }], roots)).toEqual(roots);
    expect(foldersWithFiles([], roots)).toEqual([]);
  });

  it('shows the skeleton only while the first look is on its way, and an empty folder as empty', () => {
    expect(scratchState(undefined)).toBe('loading');
    expect(scratchState(null)).toBe('missing');
    expect(scratchState({ files: [] })).toBe('empty');
    expect(scratchState({ files: [{ path: '.context/a', size: 1, mtime: 1 }] })).toBe('files');
  });

  it('draws a web page in a sandbox with nothing allowed (no scripts, no same origin), and keeps its source a click away', () => {
    expect(isHtmlFile('.beluga/scratch/report.html')).toBe(true);
    expect(isHtmlFile('a.htm')).toBe(true);
    expect(isHtmlFile('a.xhtml.txt')).toBe(false);
    expect(HTML_SANDBOX).toBe('');
    expect(hasRenderedLook('report.html')).toBe(true);
    expect(hasRenderedLook('notes.md')).toBe(true);
    expect(hasRenderedLook('run.log')).toBe(false);
    // Still text: it can be copied, searched and shown as source.
    expect(hasText({ path: 'report.html', content: '<p>hi</p>' })).toBe(true);
  });
});
