import { native } from './boot.js';

/**
 * The browser's clipboard the old way, for a page that isn't a secure context (Beluga in a browser
 * over plain http on your network, docs/web.md): there navigator.clipboard doesn't exist at all.
 * A copy command, during the click that asked for it, with what to copy put in by its copy event.
 */
function copyByCommand(text: string, html?: string): void {
  const onCopy = (e: ClipboardEvent): void => {
    e.clipboardData?.setData('text/plain', text);
    if (html) e.clipboardData?.setData('text/html', html);
    e.preventDefault();
  };
  // Something selected, or some browsers don't fire the copy at all; given back afterwards.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const sel = document.getSelection();
  const ranges = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
  document.body.appendChild(area);
  area.select();
  document.addEventListener('copy', onCopy, true);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', onCopy, true);
    area.remove();
    if (sel) {
      sel.removeAllRanges();
      for (const r of ranges) sel.addRange(r);
    }
    focused?.focus({ preventScroll: true });
  }
  if (!ok) throw new Error("The browser didn't allow copying");
}

/** Put text on the clipboard (the app's own clipboard, or the browser's). */
export async function copyText(text: string): Promise<void> {
  if (native('clipboard')) {
    const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeText(text);
  } else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else copyByCommand(text);
}

/**
 * Put HTML on the clipboard with its plain text beside it: a table pastes as a table where the
 * other side reads HTML (Sheets, Numbers, Docs, Notion), and as the text everywhere else.
 */
export async function copyRich(html: string, text: string): Promise<void> {
  if (native('clipboard')) {
    const { writeHtml } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeHtml(html, text);
  } else if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
  } else copyByCommand(text, html);
}

/**
 * Put a PNG on the clipboard. The app writes it through its own clipboard: WebKit refuses a
 * picture written after an await, once the click no longer counts. A browser gets the picture
 * as a promise, so the write starts inside the click and the bytes follow.
 */
export async function copyPng(png: Blob | Promise<Blob>): Promise<void> {
  if (native('clipboard')) {
    const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
    await writeImage(new Uint8Array(await (await png).arrayBuffer()));
  } else await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
