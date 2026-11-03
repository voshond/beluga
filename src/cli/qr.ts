import qrcode from 'qrcode-generator';

/** Light around the code, in modules: scanners need some, a terminal has little room. */
const QUIET = 2;
/** Black on bright white, whatever the terminal's own colors: phones read dark-on-light best. */
const PAINT = '\x1b[30;107m';
const RESET = '\x1b[0m';

/**
 * A QR code as lines of half-block characters: each character is two modules, one above the
 * other, so the code is as wide as it has modules (plus its margin) and half as tall.
 * `color`: paint it black on white; without, dark modules are drawn in the terminal's text color.
 */
export function qrLines(text: string, { color = true }: { color?: boolean } = {}): string[] {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const size = qr.getModuleCount();
  const dark = (r: number, c: number): boolean => r >= 0 && c >= 0 && r < size && c < size && qr.isDark(r, c);
  const lines: string[] = [];
  for (let r = -QUIET; r < size + QUIET; r += 2) {
    let line = '';
    for (let c = -QUIET; c < size + QUIET; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(color ? `${PAINT}${line}${RESET}` : line);
  }
  return lines;
}

/** How many columns the code takes. */
export const qrWidth = (lines: readonly string[]): number => [...(lines[0] ?? '').replace(/\x1b\[[\d;]*m/g, '')].length;
