/**
 * A small made-up PDF (a two-page brand brief) for the demo's landing worktree, written by hand
 * so the demo needs no files: Helvetica text and a colored band per page, with a correct xref.
 */

const PAGE_W = 612;
const PAGE_H = 792;

const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** One page's drawing: a band across the top, a title, then lines of text. */
function pageStream(title: string, lines: readonly string[], rgb: readonly [number, number, number]): string {
  const band = `${rgb.join(' ')} rg 0 ${PAGE_H - 120} ${PAGE_W} 120 re f`;
  const head = `BT /F1 30 Tf 1 1 1 rg 56 ${PAGE_H - 78} Td (${esc(title)}) Tj ET`;
  const body = lines.map((l, i) => `BT /F1 13 Tf 0.15 0.15 0.18 rg 56 ${PAGE_H - 170 - i * 22} Td (${esc(l)}) Tj ET`).join('\n');
  return `${band}\n${head}\n${body}\n`;
}

/** The brief, or only its first `count` pages (a shorter one written over it, for tests). */
export function demoPdf(count = 2): Buffer {
  const pages = [
    pageStream('Launch brand brief', ['Build together: you, your friends, and everyone\'s Claude.', '', 'Voice: plain, warm, a little playful.', 'Never: hype, exclamation marks, jargon.', '', 'Hero: one line, one button, one screenshot.'], [0.36, 0.42, 0.93]),
    pageStream('Colors and type', ['Accent: system blue. Everything else stays neutral.', 'Type: SF Pro for the app, Inter on the web.', '', 'Screenshots: dark mode, 2x, no fake data.'], [0.15, 0.62, 0.47]),
  ].slice(0, count);
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // the page tree, filled in once the pages have numbers
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = pages.map((stream) => {
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`);
    return add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = Buffer.byteLength(out, 'latin1');
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
