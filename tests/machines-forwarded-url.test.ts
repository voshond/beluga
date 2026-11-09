import { describe, expect, it } from 'vitest';
import { swapPort } from '../packages/mac/src/machines/forwarded-url.js';
import type { PortForward } from '../src/shared/forwards.js';

/** A live preview on one of your computers, reached here through the app's forward (BLG-769 × BLG-802). */
const fwd = (machineId: string, port: number, local: number): PortForward => ({ machineId, machineName: 'build-box', workspaceId: 'w1', port, local, name: 'Live preview' });

describe('a computer’s page as this Mac reaches it', () => {
  it('swaps the computer’s port for the one forwarded here, keeping the path', () => {
    expect(swapPort('http://127.0.0.1:47791/p/abc/?v=2', 'm1', [fwd('m1', 47791, 47792)])).toBe('http://127.0.0.1:47792/p/abc/?v=2');
    expect(swapPort('http://localhost:3000/', 'm1', [fwd('m1', 3000, 3000)])).toBe('http://localhost:3000/');
  });
  it('waits (undefined) while that port isn’t forwarded yet, and only for that computer', () => {
    expect(swapPort('http://127.0.0.1:47791/p/abc/', 'm1', [])).toBeUndefined();
    expect(swapPort('http://127.0.0.1:47791/p/abc/', 'm1', [fwd('m2', 47791, 47792)])).toBeUndefined();
  });
  it('leaves an address that isn’t the computer’s localhost as it is', () => {
    expect(swapPort('https://example.com/x', 'm1', [])).toBe('https://example.com/x');
    expect(swapPort('not a url', 'm1', [])).toBe('not a url');
  });
});
