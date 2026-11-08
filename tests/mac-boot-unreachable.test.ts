import { describe, expect, it } from 'vitest';
import { unreachableDetail } from '../packages/mac/src/lib/boot.js';

describe('unreachableDetail', () => {
  it('says the server is restarting when a proxy answers 502, 503 or 504', () => {
    expect(unreachableDetail(502, 'Bad Gateway')).toBe('The server is restarting (502 Bad Gateway). Beluga reconnects by itself.');
    expect(unreachableDetail(503, '')).toBe('The server is restarting (503). Beluga reconnects by itself.');
  });

  it('names any other page it did not expect', () => {
    expect(unreachableDetail(404, 'Not Found')).toBe('The server answered with a page Beluga didn’t expect (404 Not Found).');
  });
});
