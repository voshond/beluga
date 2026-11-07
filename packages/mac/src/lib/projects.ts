import { useEffect, useState } from 'react';
import type { BelugaClient } from '@beluga/ipc/client.js';
import { inApp, webServed } from './boot.js';
import { useBeluga } from './beluga.js';

/** A project's icon as an image URL, or null when it has none (it gets its initial instead). */
type Icon = string | null;

// Read once per project per window; changing it (Change Icon…) reads it again.
const cache = new Map<string, Promise<Icon>>();
const listeners = new Set<(projectId: string) => void>();

function load(client: BelugaClient, key: string): Promise<Icon> {
  // No project (Your Mac's): no icon to ask for.
  if (!key) return Promise.resolve(null);
  let p = cache.get(key);
  if (!p) {
    // "path:/…" is a folder that isn't a project yet.
    const read = key.startsWith('path:') ? client.api.projects.iconAt(key.slice(5)) : client.api.projects.icon(key);
    p = read.then(
      (icon) => (icon ? `data:${icon.mime};base64,${icon.data}` : null),
      () => null,
    );
    cache.set(key, p);
  }
  return p;
}

/** An icon with its transparent margin cut away (an app icon's padding), so it fills a circle. */
const trimmed = (url: string): Promise<string> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(url);
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!w || !h || !ctx) return resolve(url);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0);
      const alpha = ctx.getImageData(0, 0, w, h).data;
      let [left, top, right, bottom] = [w, h, -1, -1];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (alpha[(y * w + x) * 4 + 3]! > 24) {
            left = Math.min(left, x);
            right = Math.max(right, x);
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
      if (right < 0 || (left === 0 && top === 0 && right === w - 1 && bottom === h - 1)) return resolve(url);
      const side = Math.max(right - left, bottom - top) + 1;
      const out = document.createElement('canvas');
      out.width = side;
      out.height = side;
      out.getContext('2d')?.drawImage(canvas, left - (side - (right - left + 1)) / 2, top - (side - (bottom - top + 1)) / 2, side, side, 0, 0, side, side);
      resolve(out.toDataURL('image/png'));
    };
    img.src = url;
  });

function loadTrimmed(client: BelugaClient, key: string): Promise<Icon> {
  let p = cache.get(`trim:${key}`);
  if (!p) {
    p = load(client, key).then((icon) => (icon ? trimmed(icon) : null));
    cache.set(`trim:${key}`, p);
  }
  return p;
}

/** Forget a project's icon so it's read again everywhere it shows. */
export function reloadProjectIcon(projectId: string): void {
  cache.delete(projectId);
  cache.delete(`trim:${projectId}`);
  for (const l of [...listeners]) l(projectId);
}

/** `trim`: without the icon's transparent margin (for a round mark). */
export function useProjectIcon(projectId: string, trim = false): Icon | undefined {
  const { client } = useBeluga();
  const [icon, setIcon] = useState<Icon | undefined>(undefined);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const l = (id: string): void => void (id === projectId && setVersion((v) => v + 1));
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    void (trim ? loadTrimmed : load)(client, projectId).then((i) => alive && setIcon(i));
    return () => {
      alive = false;
    };
  }, [client, projectId, version, trim]);
  return icon;
}

/**
 * Choose folders with the Mac's own Open panel; in a page the web port served, the server's
 * folders in Beluga's own picker (undefined in a development browser, or when cancelled).
 */
export async function pickFolders(title: string): Promise<string[] | undefined> {
  if (!inApp()) {
    if (!webServed()) return undefined;
    const { browseFolder } = await import('../dialogs/FolderBrowser.js');
    const picked = await browseFolder(title);
    return picked ? [picked] : undefined;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: true, title });
  if (!picked) return undefined;
  return Array.isArray(picked) ? picked : [picked];
}

/** Choose an image file with the Open panel (in a served page: the browser's, uploaded to the server). */
export async function pickImage(title: string): Promise<string | undefined> {
  if (!inApp()) {
    if (!webServed()) return undefined;
    const { chooseLocalFiles, uploadFile } = await import('./web-files.js');
    const [file] = await chooseLocalFiles({ accept: 'image/png,image/svg+xml,image/jpeg,image/webp,image/x-icon' });
    return file ? (await uploadFile(file)).path : undefined;
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, title, filters: [{ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp', 'ico'] }] });
  return typeof picked === 'string' ? picked : undefined;
}
