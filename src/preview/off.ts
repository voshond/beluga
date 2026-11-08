/**
 * The one piece of live previews the daemon always loads: a way to close them. The previews
 * themselves (src/preview/manager.ts, esbuild, the server) load on the first preview opened and
 * register here, so with the experiment off nothing of them is ever loaded or run.
 */

let close: (() => Promise<void>) | undefined;

/** Called by the previews once they start: how to let all of them go. */
export function previewsStarted(closer: () => Promise<void>): void {
  close = closer;
}

/** Every preview let go (the experiment turned off, the daemon stopping); nothing when none ran. */
export async function closePreviews(): Promise<void> {
  const c = close;
  close = undefined;
  await c?.().catch(() => undefined);
}
