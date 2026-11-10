import { type RefObject, useEffect, useMemo, useRef } from "react";
import { splitWorktreeRefs } from "@beluga/shared/worktree-refs.js";
import { useApp } from "../lib/beluga.js";
import { ImageChip } from "./ImageChip.js";
import { IMAGE_REF, refOf } from "./image-refs.js";
import {
  type MentionPiece,
  type MentionWorld,
  splitMentions,
} from "./mentions.js";
import m from "./mention.module.css";

function withImages(piece: MentionPiece): MentionPiece[] {
  if ("ref" in piece) return [piece];
  const out: MentionPiece[] = [];
  let last = 0;
  for (const m of piece.text.matchAll(IMAGE_REF)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: piece.text.slice(last, at) });
    // "[2 …142525-fpxw]": the pasted image it points at, a chip with the end of its name.
    const { n, name } = refOf(m);
    out.push({ raw: m[0], ref: { kind: "image", label: name ?? `image ${n}` } });
    last = at + m[0].length;
  }
  if (last < piece.text.length) out.push({ text: piece.text.slice(last) });
  return out;
}

/** A pasted worktree link ("worktree:wt-…", BLG-878) to one of yours: a chip with its name, as an image's. */
function withWorktrees(piece: MentionPiece, names: ReadonlyMap<string, string>): MentionPiece[] {
  if ("ref" in piece || !names.size) return [piece];
  return splitWorktreeRefs(piece.text, (id) => names.has(id)).map((p) =>
    "id" in p ? { raw: p.raw, ref: { kind: "worktree", label: names.get(p.id)!, id: p.id } } : p,
  );
}

/** Each worktree's name by id, as one string (so the box draws again only when one changes). */
const namesOf = new WeakMap<object, string>();
function worktreeNames(projects: readonly { readonly workspaces: readonly { readonly id: string; readonly kind: string; readonly name: string }[] }[]): string {
  let names = namesOf.get(projects);
  if (names === undefined) namesOf.set(projects, (names = JSON.stringify(projects.flatMap((p) => p.workspaces.filter((w) => w.kind === "worktree").map((w) => [w.id, w.name])))));
  return names;
}

/** Drawn as a chip over the room its words take (the box's own words go see-through). */
const isChip = (p: MentionPiece): boolean => "ref" in p && (p.ref.kind === "image" || p.ref.kind === "worktree");

/**
 * Behind the message box: the same text, invisible, with every mention that names someone or
 * something marked, so "@mia" or "@src/auth.ts" shows as a pill while you type. It follows the
 * box's scrolling; the box itself stays a plain text field (typing, selection, undo as usual).
 *
 * An image's reference is drawn as a chip (an icon and the end of its file name) over the room
 * its words take, and so is a pasted worktree link (its branch icon and name): while there is one, the words show from here and the box's own go see-through
 * (its caret and selection stay).
 */
/** A box with no mentions to mark (only its images). */
const NO_MENTIONS: MentionWorld = {
  friends: [],
  peers: [],
  projects: [],
  workspaces: [],
};

export function MentionHighlighter({
  text,
  world = NO_MENTIONS,
  input,
  className,
}: {
  text: string;
  world?: MentionWorld;
  input: RefObject<HTMLTextAreaElement | null>;
  className: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const known = useApp((st) => (text.includes("worktree:") ? worktreeNames(st.projects) : "[]"));
  const pieces = useMemo(() => {
    const names = new Map(JSON.parse(known) as [string, string][]);
    return splitMentions(text, world)
      .flatMap(withImages)
      .flatMap((p) => withWorktrees(p, names));
  }, [text, world, known]);
  const chips = pieces.some(isChip);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.classList.toggle(m.inkBehind!, chips);
    return () => el.classList.remove(m.inkBehind!);
  }, [input, chips]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const follow = (): void => {
      if (layer.current) layer.current.scrollTop = el.scrollTop;
    };
    follow();
    el.addEventListener("scroll", follow);
    return () => el.removeEventListener("scroll", follow);
  }, [input, text]);
  if (!pieces.some((p) => "ref" in p)) return null;
  return (
    <div
      ref={layer}
      className={`${className} ${m.highlighter}`}
      aria-hidden="true"
      data-testid="mention-highlighter"
      data-ink={chips || undefined}
    >
      {pieces.map((p, i) =>
        "ref" in p && isChip(p) ? (
          <mark key={i} className={m.imageChip} data-mention={p.raw} data-kind={p.ref.kind}>
            <span className={m.chipRoom}>{p.raw}</span>
            <ImageChip className={p.ref.kind === "worktree" ? `${m.chipFace} ${m.chipHug}` : m.chipFace} label={p.ref.label} icon={p.ref.kind === "worktree" ? "branch" : "image"} />
          </mark>
        ) : "ref" in p ? (
          <mark
            key={i}
            className={m.mark}
            data-kind={p.ref.kind}
            data-mention={p.raw}
          >
            {p.raw}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
      {/* A last line that ends in a newline still takes its height. */}
      {"​"}
    </div>
  );
}
