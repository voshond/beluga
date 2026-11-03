import { describe, expect, it } from 'vitest';
import type { Graph, GraphEdge, GraphNode } from '../src/shared/graph-spec.js';
import { type Size, elkGraph, nodeBoxes, placesOf, routesOf } from '../src/shared/render/graph-model.js';
import { START_ZOOM, packedLayout, startView } from '../src/shared/render/graph-pack.js';
import { layout } from '../packages/mac/src/components/graph/layout.js';

/** A busy board (BLG-691): epics of loose sub-tasks, a few waiting on each other, one across epics. */
function board(epics: number, size: number): Graph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (let e = 0; e < epics; e++) {
    nodes.push({ id: `e${e}`, type: 'group', label: `Epic ${e}` });
    for (let k = 0; k < size; k++) {
      nodes.push({ id: `e${e}.${k}`, type: 'task', label: `Task ${k}`, group: `e${e}` });
      if (k % 3 === 2) edges.push({ id: `e${e}.${k - 1}->e${e}.${k}`, from: `e${e}.${k - 1}`, to: `e${e}.${k}`, kind: 'blocks' });
    }
  }
  edges.push({ id: 'across', from: 'e0.0', to: 'e1.0', kind: 'blocks' });
  return { title: 'Board', direction: 'right', nodes, edges, steps: [] };
}

const sizes = (g: Graph): Map<string, Size> => new Map(g.nodes.map((n) => [n.id, { width: 240, height: 74 }]));

describe('a busy graph, packed', () => {
  it('fits the frame’s shape where one layout is a single tall column', async () => {
    const g = board(10, 12);
    const whole = await layout(elkGraph(g, sizes(g), 'right'));
    const packed = await packedLayout(g, sizes(g), 'right', 1.6, (input) => layout(input));
    // Laid out whole, every epic sits in the first layer: far taller than wide.
    expect(whole.height! / whole.width!).toBeGreaterThan(2.5);
    const ratio = packed.width! / packed.height!;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(3);
    expect(packed.height!).toBeLessThan(whole.height! / 2);
  });

  it('places every node inside its group and routes the lines within a group', async () => {
    const g = board(4, 6);
    const out = await packedLayout(g, sizes(g), 'down', 1.6, (input) => layout(input));
    const places = placesOf(out);
    expect(places.size).toBe(g.nodes.length);
    for (const n of g.nodes.filter((x) => x.group)) {
      const at = places.get(n.id)!;
      const box = places.get(n.group!)!;
      // Relative to its group, within it.
      expect(at.x).toBeGreaterThanOrEqual(0);
      expect(at.y).toBeGreaterThanOrEqual(0);
      expect(at.x + at.width).toBeLessThanOrEqual(box.width);
      expect(at.y + at.height).toBeLessThanOrEqual(box.height);
    }
    const routes = routesOf(out);
    // Lines inside a group follow ELK's route; the one across groups curves on its own.
    expect([...routes.keys()].sort()).toEqual(g.edges.filter((e) => e.id !== 'across').map((e) => e.id).sort());
    // No two nodes overlap.
    const boxes = nodeBoxes(out);
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  });
});

describe('where a busy graph opens', () => {
  const frame = { width: 1200, height: 760 };

  it('shows all of a graph that reads whole, centered', () => {
    const view = startView({ width: 800, height: 400 }, frame, []);
    expect(view.zoom).toBe(1);
    expect(view.x).toBe(200);
    expect(view.y).toBe(180);
  });

  it('opens a big one readable, on the most of the work going on, inside its edges', () => {
    const bounds = { width: 4000, height: 3000 };
    // One task at the top left, three together further in: the view goes to the three.
    const wanted = [
      { x: 40, y: 40, width: 240, height: 74 },
      { x: 2000, y: 1500, width: 240, height: 74 },
      { x: 2300, y: 1600, width: 240, height: 74 },
      { x: 2100, y: 1800, width: 240, height: 74 },
    ];
    const view = startView(bounds, frame, wanted);
    expect(view.zoom).toBe(START_ZOOM);
    const inView = (b: (typeof wanted)[number]): boolean => b.x * view.zoom + view.x >= 0 && (b.x + b.width) * view.zoom + view.x <= frame.width && b.y * view.zoom + view.y >= 0 && (b.y + b.height) * view.zoom + view.y <= frame.height;
    expect(wanted.filter(inView)).toHaveLength(3);
    // Nothing to go to: the top left. And never past the far edges.
    expect(startView(bounds, frame, [])).toMatchObject({ zoom: START_ZOOM, x: 28, y: 28 });
    const corner = startView(bounds, frame, [{ x: 3900, y: 2950, width: 100, height: 50 }]);
    expect(corner.x).toBeCloseTo(frame.width - (bounds.width * START_ZOOM + 28));
    expect(corner.y).toBeCloseTo(frame.height - (bounds.height * START_ZOOM + 28));
  });

  it('puts the view’s corner at a group’s, so no epic opens cut in half', () => {
    const bounds = { width: 4000, height: 3000 };
    const wanted = [{ x: 900, y: 600, width: 240, height: 74 }];
    const view = startView(bounds, frame, wanted, [{ x: 500, y: 400, width: 1200, height: 800 }]);
    expect(view.x).toBeCloseTo(-(500 * START_ZOOM) + 28);
    expect(view.y).toBeCloseTo(-(400 * START_ZOOM) + 28);
  });
});
