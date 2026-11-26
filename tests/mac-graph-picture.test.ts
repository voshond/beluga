import { describe, expect, it } from 'vitest';
import { pictureName, pictureScale } from '../packages/mac/src/components/graph/graph-picture.js';

describe("a graph's picture", () => {
  it('is named after the title, with nothing a file name can’t hold', () => {
    expect(pictureName('Service case statuses')).toBe('Service case statuses.png');
    expect(pictureName('Open / Closed: a "path"')).toBe('Open Closed a path.png');
    expect(pictureName(undefined)).toBe('Graph.png');
    expect(pictureName('  ')).toBe('Graph.png');
  });

  it('is twice as sharp as the screen, unless the web view could not draw that', () => {
    expect(pictureScale(800, 600)).toBe(2);
    expect(pictureScale(12_000, 400)).toBe(1);
    expect(pictureScale(8000, 8000)).toBeCloseTo(0.79, 2);
  });
});
