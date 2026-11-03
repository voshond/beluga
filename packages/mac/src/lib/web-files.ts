import type { Location } from '@beluga/core/store.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';

/**
 * Files between this browser and the computer Beluga runs on, when the page came from its web
 * port (src/daemon/web-files.ts): what you drop or pick is uploaded there first (the chat and
 * tasks use its path there, as the app uses a file's path on the Mac); what you save comes down
 * as a download.
 */

export interface Uploaded {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

/** Send one file to the computer Beluga runs on; where it landed there. */
export async function uploadFile(file: File): Promise<Uploaded> {
  const res = await fetch(`/upload?name=${encodeURIComponent(file.name || 'file')}`, { method: 'POST', body: file, credentials: 'same-origin', headers: { 'content-type': 'application/octet-stream' } });
  const body = (await res.json().catch(() => ({}))) as Partial<Uploaded> & { error?: string };
  if (!res.ok || !body.path) throw new Error(body.error ?? `The upload of ${file.name} didn’t work`);
  return { path: body.path, name: body.name ?? file.name, size: body.size ?? file.size };
}

/** Upload several (one at a time, so a big one doesn't starve the rest); those that failed are said by `onError`. */
export async function uploadFiles(files: readonly File[], onError: (file: File, err: unknown) => void): Promise<Uploaded[]> {
  const done: Uploaded[] = [];
  for (const f of files) {
    try {
      done.push(await uploadFile(f));
    } catch (err) {
      onError(f, err);
    }
  }
  return done;
}

/** Let the browser save a file of the computer Beluga runs on (a path there, or a shared file). */
export async function download(client: SocketClient, target: { path: string } | { at: Location }): Promise<string> {
  const { url, name } = await client.api.web.download(target);
  const a = Object.assign(document.createElement('a'), { href: url, download: name, rel: 'noopener' });
  document.body.append(a);
  a.click();
  a.remove();
  return name;
}

/** The browser's own file picker: the files you choose (none when you cancel). */
export function chooseLocalFiles(opts: { multiple?: boolean; accept?: string } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: opts.multiple ?? false, accept: opts.accept ?? '' });
    input.style.display = 'none';
    const finish = (files: File[]): void => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}
