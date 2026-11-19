import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { Bitmap } from './bitmap.js';
import { decodeImage } from './decode.js';

/** Give up on a decode that takes longer than this (a hostile file shouldn't wedge the viewer). */
const DECODE_TIMEOUT_MS = 20_000;

type Reply = { id: number; image?: Bitmap; error?: string };

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (b: Bitmap) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

function failAll(err: Error): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
  worker = undefined;
}

function getWorker(): Worker | undefined {
  if (worker) return worker;
  const url = new URL('./worker.js', import.meta.url);
  // Running from source (tests, tsx) there is no compiled worker; decode inline instead.
  if (!existsSync(fileURLToPath(url))) return undefined;
  const w = new Worker(url, { execArgv: [] });
  w.on('message', (msg: Reply) => {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.image) p.resolve(msg.image);
    else p.reject(new Error(msg.error ?? 'Could not read the image'));
  });
  w.on('error', (err: unknown) => failAll(err instanceof Error ? err : new Error(String(err))));
  w.on('exit', () => failAll(new Error('The image decoder stopped')));
  // An idle decoder must never keep Beluga running (unref after listeners, which re-ref).
  w.unref();
  worker = w;
  return w;
}

/** Decode in a background thread (falls back to inline decoding when no worker is available); `keepSide` as decodeImage's. */
export function decodeImageAsync(bytes: Uint8Array, name: string, keepSide?: number): Promise<Bitmap> {
  const w = getWorker();
  if (!w) return Promise.resolve().then(() => decodeImage(bytes, name, keepSide));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // A stuck decode can't be interrupted from outside, so replace the worker.
      void w.terminate();
      reject(new Error('The image took too long to read'));
    }, DECODE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, bytes, name, keepSide });
  });
}
