import type { Graph, GraphDirection, GraphNode } from '../graph-spec.js';
import { type Box, type ElkInput, type ElkOutput, type ElkOutputEdge, GROUP_HEAD, SIMPLEX_MAX_EDGES, type Size, backEdges, fitZoom, labelSize } from './graph-model.js';

/**
 * A busy graph (a board's What Waits on What, BLG-691), laid out to fit the frame it's shown in.
 * Laid out in one go, ELK puts every piece that waits on nothing in the same first layer: a board
 * of epics becomes one column thousands of pixels tall, shown at a zoom nobody can read. Here each
 * group is laid out on its own first, its loose pieces packed into rows, and then the groups and
 * loose tasks are packed the same way, as boxes, into the frame's shape. Lines between groups
 * count for where things go; ELK draws only the lines inside one group (the rest curve).
 */

/** From how many nodes a graph that asks for it is packed (a small one reads best laid out whole). */
export const PACK_FROM = 30;

/** The shape a group's own pieces are packed into. */
const GROUP_ASPECT = 1.6;

const ELK_DIRECTION: Readonly<Record<GraphDirection, string>> = { right: 'RIGHT', down: 'DOWN', left: 'LEFT', up: 'UP' };

/** Lay one ELK graph out (in the window, its worker). */
export type RunLayout = (graph: ElkInput) => Promise<ElkOutput>;

function options(graph: Graph, direction: GraphDirection, aspect: number, root: boolean): Record<string, string> {
  const vertical = direction === 'down' || direction === 'up';
  const labelled = graph.edges.some((e) => e.label);
  return {
    'elk.algorithm': 'layered',
    'elk.direction': ELK_DIRECTION[direction],
    'elk.separateConnectedComponents': 'true',
    'elk.aspectRatio': aspect.toFixed(2),
    'elk.spacing.componentComponent': root ? '56' : '28',
    'elk.layered.spacing.nodeNodeBetweenLayers': String(vertical ? (labelled ? 30 : 64) : labelled ? 44 : 84),
    'elk.spacing.nodeNode': vertical ? '40' : '32',
    'elk.layered.spacing.edgeNodeBetweenLayers': vertical ? '18' : '22',
    'elk.spacing.edgeLabel': '4',
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.edgeLabels.placement': 'CENTER',
    'elk.edgeLabels.inline': 'true',
    'elk.spacing.edgeEdge': '16',
    'elk.layered.nodePlacement.strategy': graph.edges.length <= SIMPLEX_MAX_EDGES ? 'NETWORK_SIMPLEX' : 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.favorStraightEdges': 'true',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.padding': root ? '[top=20,left=20,bottom=20,right=20]' : `[top=${GROUP_HEAD + 14},left=22,bottom=22,right=22]`,
  };
}

/**
 * The packed layout, in the shape ELK answers a whole graph with (placesOf, routesOf and nodeBoxes
 * read it the same way): groups hold their children, every drawn line is in `edges` with the group
 * its points are relative to.
 */
export async function packedLayout(graph: Graph, sizes: ReadonlyMap<string, Size>, direction: GraphDirection, aspect: number, run: RunLayout): Promise<ElkOutput> {
  const groups = new Set(graph.nodes.filter((n) => n.type === 'group').map((n) => n.id));
  const parent = new Map<string, string>();
  const kids = new Map<string | undefined, GraphNode[]>();
  for (const n of graph.nodes) {
    const g = n.group && groups.has(n.group) ? n.group : undefined;
    if (g) parent.set(n.id, g);
    kids.set(g, [...(kids.get(g) ?? []), n]);
  }
  // What stands for `id` among `container`'s own children (itself, or the group it's somewhere inside).
  const under = (id: string, container: string | undefined): string | undefined => {
    for (let at: string | undefined = id; at !== undefined; at = parent.get(at)) if (parent.get(at) === container) return at;
    return undefined;
  };
  const back = backEdges(graph);
  const drawn: ElkOutputEdge[] = [];

  const lay = async (container: string | undefined): Promise<ElkOutput> => {
    const inner = kids.get(container) ?? [];
    const boxes = await Promise.all(inner.map((n) => (kids.get(n.id)?.length ? lay(n.id) : undefined)));
    const children = inner.map((n, i) => {
      const box = boxes[i];
      if (box) return { id: n.id, width: box.width ?? 0, height: box.height ?? 0 };
      // An empty group is drawn as a box of its own size.
      if (n.type === 'group') return { id: n.id, width: 220, height: 96 };
      return { id: n.id, ...(sizes.get(n.id) ?? { width: 180, height: 56 }) };
    });
    const pairs = new Set<string>();
    const own = new Set<string>();
    const edges: NonNullable<ElkInput['edges']>[number][] = [];
    for (const e of graph.edges) {
      const a = under(e.from, container);
      const b = under(e.to, container);
      if (a === undefined || b === undefined || a === b) continue;
      const direct = a === e.from && b === e.to;
      const [from, to] = back.has(e.id) ? [b, a] : [a, b];
      // A line from deeper inside counts once per pair, for where things go.
      if (!direct && pairs.has(`${from}>${to}`)) continue;
      pairs.add(`${from}>${to}`);
      if (direct) own.add(e.id);
      edges.push({ id: direct ? e.id : `lift:${e.id}`, sources: [from], targets: [to], ...(direct && e.label ? { labels: [{ text: e.label, ...labelSize(e.label) }] } : {}) });
    }
    const id = container ?? 'root';
    const out = await run({ id, layoutOptions: options(graph, direction, container ? GROUP_ASPECT : aspect, !container), children, edges });
    for (const e of out.edges ?? []) if (own.has(e.id)) drawn.push({ ...e, container: id });
    const placed = new Map((out.children ?? []).map((c) => [c.id, c]));
    return {
      ...out,
      edges: [],
      children: inner.map((n, i) => {
        const at = placed.get(n.id) ?? { id: n.id };
        const box = boxes[i];
        return box ? { ...box, id: n.id, x: at.x ?? 0, y: at.y ?? 0 } : at;
      }),
    };
  };

  const out = await lay(undefined);
  return { ...out, edges: drawn };
}

/** The zoom a board opens at when all of it wouldn't be readable: about where its words still read. */
export const START_ZOOM = 0.65;

export interface View {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/**
 * Where a big graph opens: the whole of it when that reads (`START_ZOOM` or more), else at
 * `START_ZOOM` over the part with the most of `wanted` in it (the work going on), the top-left
 * first, never past the graph's edges. The view's corner is tried at each of `anchors` (the
 * groups the wanted nodes are in, so none opens cut in half).
 */
export function startView(bounds: Size, frame: Size, wanted: readonly Box[], anchors: readonly Box[] = wanted, pad = 28): View {
  const fit = fitZoom(bounds, frame, pad);
  const centered = (zoom: number): View => ({ x: (frame.width - bounds.width * zoom) / 2, y: (frame.height - bounds.height * zoom) / 2, zoom });
  if (fit >= START_ZOOM) return centered(fit);
  const zoom = START_ZOOM;
  const w = frame.width / zoom;
  const h = frame.height / zoom;
  const margin = pad / zoom;
  // Each anchor tried as the top-left of the view: the one that shows the most wanted nodes wins.
  let best = { x: 0, y: 0, count: -1 };
  for (const a of anchors) {
    const x = a.x - margin;
    const y = a.y - margin;
    const count = wanted.filter((b) => b.x >= x && b.y >= y && b.x + b.width <= x + w && b.y + b.height <= y + h).length;
    if (count > best.count || (count === best.count && (y < best.y || (y === best.y && x < best.x)))) best = { x, y, count };
  }
  const along = (at: number, view: number, size: number): number => (size + 2 * margin <= view ? (size - view) / 2 : Math.max(-margin, Math.min(at, size + margin - view)));
  const x = along(best.count < 0 ? -margin : best.x, w, bounds.width);
  const y = along(best.count < 0 ? -margin : best.y, h, bounds.height);
  return { x: -x * zoom, y: -y * zoom, zoom };
}
