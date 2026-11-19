import { parentPort } from 'node:worker_threads';
import { decodeImage } from './decode.js';

/** Decodes one image per message off the UI thread, so a big photo never freezes Beluga. */
parentPort?.on('message', (msg: { id: number; bytes: Uint8Array; name: string; keepSide?: number }) => {
  try {
    const image = decodeImage(msg.bytes, msg.name, msg.keepSide);
    parentPort?.postMessage({ id: msg.id, image }, [image.data.buffer as ArrayBuffer]);
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
