import { memo } from 'react';
import { Handle, type Node, type NodeProps, type Position } from '@xyflow/react';
import type { GraphNode, NodeKind } from '@beluga/shared/graph-spec.js';
import { useBeluga } from '../../lib/beluga.js';
import { imageSource, localImage } from '../../chat/md-images.js';
import { openLightbox, useImage } from '../../chat/images.js';
import type { Side } from './graph-model.js';
import { KindIcon, StatusMark, StatusPill } from './marks.js';
import g from './graph.module.css';

/**
 * The pieces a graph is drawn with. Every kind is a quiet card in the window's greys; what sets
 * kinds apart is their icon and shape (a database lists its fields, an actor is round, a note is
 * paper, a decision has a diamond, an external system a dashed edge). Color only means something:
 * a status, the accent for what Claude marked important.
 */

export interface NodeData extends Record<string, unknown> {
  readonly node: GraphNode;
  readonly sides: { readonly source: Side; readonly target: Side };
  /** Laid out: drawn at the size the layout gave it (cards alike), its content in the middle. */
  readonly sized?: boolean;
  /** Pictures from this Mac (only in your own and your Claude's messages). */
  readonly localImages: boolean;
}

export type FlowNode = Node<NodeData>;

const cx = (...c: Array<string | false | undefined>): string => c.filter(Boolean).join(' ');

function Ends({ sides }: { sides: NodeData['sides'] }) {
  return (
    <>
      <Handle type="target" position={sides.target as Position} className={g.handle} isConnectable={false} />
      <Handle type="source" position={sides.source as Position} className={g.handle} isConnectable={false} />
    </>
  );
}

function Head({ node }: { node: GraphNode }) {
  return (
    <div className={g.head}>
      <span className={g.kindIcon} data-kind={node.type}>
        {node.type === 'actor' || node.type === 'person' ? <span className={g.initial}>{initialOf(node.label)}</span> : <KindIcon kind={node.type} size={14} />}
      </span>
      <span className={g.titles}>
        <span className={g.label}>{node.label}</span>
        {node.sublabel ? <span className={g.sublabel}>{node.sublabel}</span> : null}
      </span>
      {node.tag ? <span className={g.tag}>{node.tag}</span> : null}
    </div>
  );
}

const initialOf = (label: string): string => (label.trim()[0] ?? '?').toUpperCase();

/** How many of a node's steps show before "+N more" (all of them are in its details). */
const ITEMS_SHOWN = 10;

/**
 * A node's own steps, in order, each with its status's mark: what a CI job runs, a stage's tasks.
 * The one going now stands out; what's left fades.
 */
function Items({ items }: { items: NonNullable<GraphNode['items']> }) {
  const shown = items.slice(0, ITEMS_SHOWN);
  return (
    <ol className={g.items}>
      {shown.map((it, i) => (
        <li key={`${i}:${it.label}`} className={g.item} data-status={it.status}>
          {it.status ? <StatusMark status={it.status} /> : <span className={g.itemDot} aria-hidden="true" />}
          <span className={g.itemLabel}>{it.label}</span>
          {it.note ? <span className={g.itemNote}>{it.note}</span> : null}
        </li>
      ))}
      {items.length > shown.length ? <li className={g.itemMore}>+{items.length - shown.length} more</li> : null}
    </ol>
  );
}

/** Most kinds: an icon, a name, a line under it, a tag and a status. */
export const CardNode = memo(function CardNode({ data }: NodeProps<FlowNode>) {
  const { node } = data;
  return (
    <div className={cx(g.card, g[`kind_${node.type}`], node.emphasis && g.emphasis)} data-kind={node.type} data-sized={data.sized ? 'true' : undefined}>
      <Ends sides={data.sides} />
      {node.type === 'metric' && node.value ? (
        <div className={g.metric}>
          <span className={g.metricHead}>
            <span className={g.metricLabel}>{node.label}</span>
            {node.tag ? <span className={g.tag}>{node.tag}</span> : null}
          </span>
          <span className={g.metricValue}>{node.value}</span>
          {node.sublabel ? <span className={g.sublabel}>{node.sublabel}</span> : null}
        </div>
      ) : (
        <Head node={node} />
      )}
      {node.items?.length ? <Items items={node.items} /> : null}
      {node.status ? (
        <div className={g.foot}>
          <StatusPill status={node.status} />
        </div>
      ) : null}
    </div>
  );
});

/** A database or table: its name, then its fields (keys first in the order given). */
export const TableNode = memo(function TableNode({ data }: NodeProps<FlowNode>) {
  const { node } = data;
  const fields = node.fields ?? [];
  return (
    <div className={cx(g.card, g.table, node.emphasis && g.emphasis)} data-kind="database" data-sized={data.sized ? 'true' : undefined}>
      <Ends sides={data.sides} />
      <Head node={node} />
      {fields.length ? (
        <ul className={g.fields}>
          {fields.map((f, i) => (
            <li key={`${i}:${f.name}`} className={g.fieldRow} title={f.note}>
              <span className={g.fieldKey} data-key={f.key}>
                {f.key === 'pk' ? 'PK' : f.key === 'fk' ? 'FK' : null}
              </span>
              <span className={g.fieldName}>{f.name}</span>
              {f.type ? <span className={g.fieldType}>{f.type}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {node.status ? (
        <div className={g.foot}>
          <StatusPill status={node.status} />
        </div>
      ) : null}
    </div>
  );
});

/** A picture as proof (a screenshot of the page that changed): click for full size. */
export const ImageNode = memo(function ImageNode({ data }: NodeProps<FlowNode>) {
  const { node } = data;
  const path = node.image ?? '';
  // The same rule as a picture in a message: an absolute path to an image file on this Mac.
  const source = imageSource(path);
  const local = source.kind === 'local' && data.localImages;
  return (
    <div className={cx(g.card, g.imageCard, node.emphasis && g.emphasis)} data-kind="image">
      <Ends sides={data.sides} />
      {local ? <Picture path={source.path} label={node.label} /> : <div className={g.noPicture}>{path ? 'Pictures from other computers show as a name' : 'No picture'}</div>}
      <div className={g.imageCaption}>
        <span className={g.label}>{node.label}</span>
        {node.sublabel ? <span className={g.sublabel}>{node.sublabel}</span> : null}
      </div>
    </div>
  );
});

function Picture({ path, label }: { path: string; label: string }) {
  const { client } = useBeluga();
  const image = localImage(path, label);
  const state = useImage(client.api, image);
  if (state.status !== 'ready') return <div className={g.noPicture}>{state.status === 'loading' ? 'Loading…' : 'Can’t open this picture'}</div>;
  return (
    <button type="button" className={cx(g.picture, 'nodrag')} onClick={() => openLightbox([image])} aria-label={`Open ${label}`}>
      <img src={state.url} alt={label} draggable={false} />
    </button>
  );
}

/** A labelled box around the nodes that belong together (a service's parts, a network boundary). */
export const GroupNode = memo(function GroupNode({ data }: NodeProps<FlowNode>) {
  const { node } = data;
  return (
    <div className={cx(g.group, node.emphasis && g.emphasis)} data-kind="group">
      {/* Lines can go to a group as a whole. */}
      <Ends sides={data.sides} />
      <div className={g.groupHead}>
        <span className={g.groupMark} aria-hidden="true" />
        <span className={g.groupName}>{node.label}</span>
        {node.sublabel ? <span className={g.sublabel}>{node.sublabel}</span> : null}
        {node.tag ? <span className={g.tag}>{node.tag}</span> : null}
      </div>
    </div>
  );
});

export const NODE_TYPES = { card: CardNode, table: TableNode, image: ImageNode, group: GroupNode } as const;

/** Which drawing a node uses. */
export function drawingOf(node: GraphNode): keyof typeof NODE_TYPES {
  if (node.type === 'group') return 'group';
  if (node.type === 'image') return 'image';
  if (node.type === 'database' && node.fields?.length) return 'table';
  return 'card';
}
