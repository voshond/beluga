import type { WebSocket } from 'ws';

/**
 * A test harness's slow link (BLG-792): every frame a screen sends and gets waits `oneWayMs`, in
 * order, as over a link `2 × oneWayMs` round trip away. The demo daemon puts it on its computers'
 * pages with BELUGA_DEMO_LINK_MS (the round trip), so e2e drives remote work at a real link's pace.
 */
export function withLatency(ws: WebSocket, oneWayMs: number): WebSocket {
  if (!(oneWayMs > 0)) return ws;
  const send = ws.send.bind(ws) as (data: unknown) => void;
  const emit = ws.emit.bind(ws);
  ws.send = ((data: unknown) => {
    setTimeout(() => ws.readyState === ws.OPEN && send(data), oneWayMs);
  }) as typeof ws.send;
  ws.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (event !== 'message') return emit(event, ...args);
    setTimeout(() => emit(event, ...args), oneWayMs);
    return true;
  }) as typeof ws.emit;
  return ws;
}

/** The demo's added round trip (ms), from BELUGA_DEMO_LINK_MS; none: 0. */
export function demoLinkMs(env: NodeJS.ProcessEnv = process.env): number {
  const ms = Number(env.BELUGA_DEMO_LINK_MS ?? 0);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 10_000) : 0;
}
