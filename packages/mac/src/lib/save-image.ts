import { appInvoke, native } from './boot-mode.js';

/**
 * Save as…: a PNG the window drew (a graph's picture) written to a file you pick, on the computer
 * you sit at. The app shows the Save panel and writes it there (src-tauri/src/export.rs), the app
 * as a client too; a browser, or a client app too old for that, downloads it. The path it went
 * to, or undefined when you cancelled.
 */
export async function saveImageAs(name: string, png: Blob): Promise<string | undefined> {
  if (native('saveImage')) {
    const data = Array.from(new Uint8Array(await png.arrayBuffer()));
    const saved = await appInvoke<string | null>('save_image', { name, data }).then(
      (to) => ({ to: to ?? undefined }),
      (err: unknown) => {
        // A client app from before Save as Image doesn't have the command: the download below does it.
        if (/not found|not allowed/i.test(String(err))) return undefined;
        throw err instanceof Error ? err : new Error(String(err));
      },
    );
    if (saved) return saved.to;
  }
  const url = URL.createObjectURL(png);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
