# Graphs (`beluga-graph`, Mac app)

Your agent can draw. When a picture explains better than prose, it adds a fenced block tagged `beluga-graph` with JSON in it, and the Mac app draws it as an interactive diagram. Examples: architecture, how parts talk, a request or data flow, a pipeline, a data model, dependencies, a plan, what a change touched.

- **How to ask:** `/visualize <what>` (or ⌘K › *Draw This as a Graph*). Words like "visualize", "diagram" or "map out" in any message work too, and the agent also draws on its own when it helps.
- **Where graphs show:** answers in any conversation, reports, and Markdown files opened in Beluga.

## What you can do with one

- **Point** at a node: it and everything it touches light up, and the rest fades.
- **Click** a node for its details:
  - the agent's notes (Markdown)
  - a database's fields
  - links: files open in Beluga, pages in the browser
  - its connections: click one to go there
- **Walk Me Through It** (▶) steps through the walkthrough the agent wrote. Each step frames a few nodes, with a caption. Use ← and → to move, Esc to leave.
- **Turn the layout** between left-to-right and top-to-bottom.
- **Drag** nodes around. Their lines follow.
- **Open in Full Window:** room to explore, a minimap, zoom buttons, two-finger scroll to pan, pinch to zoom. Esc closes.
- **Copy as Image**, and in the right-click menu **Save as Image…**: a PNG of the whole graph at twice its size, whatever part of it the card shows, on its dotted background with 32px all round what's drawn (`drawnBox`: nodes, lines and labels, not ELK's size) and 12px round corners, see-through outside them. The window draws it again off screen (`GraphPicture.tsx`, `graph-picture.ts` with html-to-image), so the picture is made on the computer you sit at: the app as a client of a Beluga server copies to its own clipboard and saves with its own Save panel (`save_image`), never the server's.
- **Copy as JSON** (also in the right-click menu).
- **Keep in Initiative ▸** (right-click): the graph's JSON is kept as one of that initiative's artifacts and drawn live there (docs/initiatives.md, Artifacts).
- **Attach to Jira Ticket…** (right-click): its picture waits in the message box on screen with "Attach this picture of “…” to the Jira ticket". Add the key and send: your agent attaches it with its Jira tools. Nothing goes until you send it. With no chat open it says so.

In a conversation, scrolling still scrolls the conversation: pinch to zoom, drag to pan. A graph keeps the direction the agent drew it in (the toolbar turns it) and is never wrapped onto more rows (its lines would loop back across it): a wide one draws smaller in the conversation, whole in the full window and its picture. It's laid out tidy, like a diagram drawn by hand: every card the same width and every plain card the same height, cards centred in their row or column, lines leaving the middle of a side (or 32px apart around it), every gap between rows the same, and everything on the 16px dots behind it. The card's height follows the graph.

## The format

````
```beluga-graph
{
  "title": "How login works",
  "summary": "One short line under the title",
  "direction": "right",
  "nodes": [
    { "id": "web", "type": "client", "label": "Web app", "sublabel": "React · src/web" },
    { "id": "backend", "type": "group", "label": "Backend" },
    { "id": "api", "type": "service", "label": "API", "group": "backend", "status": "done",
      "details": "Markdown shown when the node is clicked",
      "links": [{ "label": "server.ts", "href": "src/server.ts" }] },
    { "id": "db", "type": "database", "label": "users", "group": "backend",
      "fields": [{ "name": "id", "type": "uuid", "key": "pk" }, { "name": "email", "type": "text" }] }
  ],
  "edges": [
    { "from": "web", "to": "api", "label": "POST /login", "kind": "call" },
    { "from": "api", "to": "db", "kind": "data" }
  ],
  "steps": [
    { "title": "1. The app asks", "text": "One or two sentences.", "focus": ["web", "api"] }
  ]
}
```
````

### The graph

| Field | Meaning |
|---|---|
| `title`, `summary` | shown above the graph |
| `direction` | `right` (the default), `down`, `left` or `up`; `LR` and `TD` work too |
| `nodes` (1–150) | the parts |
| `edges` (up to 300) | lines between them |
| `steps` (up to 30) | the walkthrough |

### Nodes

| Field | Meaning |
|---|---|
| `id`, `label` | required: an id (letters, digits, `. : / - _`) and a short name |
| `type` | one of the kinds below (near-misses like `db`, `api`, `user` are read kindly; anything else is a `service`) |
| `sublabel`, `tag` | a line under the name, a small badge |
| `status` | `todo` · `active` · `review` · `done` · `blocked` · `failed` · `idle` |
| `group` | the id of a `group` node it sits in |
| `details` | Markdown for the details panel |
| `links` | up to 8 `{label, href}`: a URL, an absolute path, or a path in the workspace |
| `emphasis` | `true` marks what matters (an accent ring) |
| `fields` | a database's columns: `{name, type?, key?: "pk" \| "fk", note?}` |
| `items` | a node's own steps, drawn inside it in order: `{label, status?, note?}` (a CI job's steps, a pipeline stage's tasks); up to 40 |
| `image` | an `image` node's picture: an absolute path on this Mac (shown only in your own and your agent's messages) |
| `value` | a `metric` node's number ("87%") |

**Kinds:**
- `client`, `service`, `function`, `file`
- `database`, `storage`, `queue`
- `external` (dashed)
- `actor`, `person` (round)
- `decision`, `note` (paper)
- `task`, `milestone`
- `image`, `metric`
- `group` (a labelled box around other nodes)

### Edges

`{from, to}` (or `source` / `target`), with optional `label`, `kind`, `emphasis` and `animated` (a moving dot).

| Kind | Looks like |
|---|---|
| `flow` | solid (the default) |
| `call` | solid, a bit stronger |
| `data` | solid, with a dot moving along it |
| `async` | dashed, moving (events, messages) |
| `depends` | dotted |
| `blocks` | the problem color |

### Steps

`{title, text?, focus}`. `focus` lists node ids and edge ids. An edge without an `id` is called `from->to`. A step lights up what it names, the lines between those nodes, and the ends of the lines it names.

### When a block is wrong

- Small mistakes are left out, and the card says how many: a duplicate id, an edge to a node that doesn't exist, a `group` that isn't a group or would contain itself.
- A block that can't be drawn shows what's wrong and its JSON.
- While the agent is still writing the block, the card says *Drawing a graph…*.

## How it works

- **Format:** `src/shared/graph-spec.ts` (zod, browser-safe). The JSON is only data: nothing in it runs, and Markdown in `details` goes through the chat's renderer.
- **Teaching the agent:** `src/agent/graph-prompt.ts` is added to every run's system prompt.
- **`/visualize`:** `runCommand` in `src/core/commands.ts` (`visualizePrompt`).
- **Drawing:** `packages/mac/src/components/graph/`:
  - `GraphBlock.tsx`: the card, the errors, the full window
  - `FlowGraph.tsx`: React Flow (`@xyflow/react`); it measures nodes out of sight, lays them out, then shows them
  - `layout.ts`: ELK (`elkjs`), layered, groups as compound nodes, orthogonal lines that ELK routes. A line that would close a loop (an answer to a call) is handed to ELK turned back, in the order lines were written (`backEdges`), so the flow reads one way. Every label gets room of its own on its line, and `placeLabels` moves any that would still cover a node or another label. Tidy (`graph-model.ts`): `tidySizes` gives cards and tables one width and plain cards one height, in whole grid steps (`GRID`, 16px; actors, people and pictures keep their own size), every line gets the same label room once any line has a label, ELK centres each layer and its line ends, and `snapToGrid` moves each column and row to its nearest grid line, a line's first and last runs with their nodes. A laid-out card fills its size (`data-sized`). The phone uses the same request and snap. `FlowGraph.tsx` lays it out the way it was drawn, whole (a packed board is packed to the frame's shape and may turn, keeping the one that reads biggest: `bestLayout` in `graph-model.ts`)
  - `graph-model.ts`: the pure parts, tested in `tests/mac-graph.test.ts`
  - `nodes.tsx`, `edges.tsx`, `Inspector.tsx`, `Walkthrough.tsx`
- **Load time:** React Flow and ELK load the first time a graph shows.
- **Mermaid, drawn our way:** a ```` ```mermaid ```` block is read into this format (`src/shared/render/mermaid.ts`) and drawn as a graph: flowcharts (shapes become kinds: `[(db)]` a database, `{x}` a decision; names like "Postgres" or "User" pick a kind too; subgraphs become groups; `:::done` a status), state diagrams, ER diagrams (entities as tables with their fields), class diagrams and sequence diagrams (each message a numbered line and a step of the walkthrough). A `pie` becomes a donut chart and a `gantt` a gantt view (docs/views.md). Anything else (mindmaps, journeys…) is left to Mermaid itself on the Mac.
- **Where blocks are found:** the chat's Markdown (`chat/Markdown.tsx`) and the document reader (`components/markdown/MarkdownDoc.tsx`) both hand ```` ```beluga-graph ```` blocks to `GraphBlock`.
- **Demo:** the demo daemon (`npm run dev` at the repo root) answers "visualize…" with a payment-flow graph (`src/agent/mock-graphs.ts`).

For tables, charts, stat tiles, code and colors (live from a file, database, web address or command), see [Views](views.md). The agent's `show` tool makes graphs too.

Graphs are the drawing engine for [Tasks and Plans](tasks-and-plans.md): plans, dependency graphs and milestone recaps are drawn with them.
