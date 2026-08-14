/**
 * Splits where **every pane is a tab**, the panes form a real window-manager
 * tree, and the strip stops trying to draw that tree past two panes.
 *
 * Today `SessionTab.layout` is already a binary tree of panes *inside* one tab
 * (`stores/sessions.ts`, `session-split-layout.tsx`) — the iTerm2/Ghostty model,
 * where splitting is invisible in the strip. This inverts the ownership: a pane
 * never hides inside a tab, it *is* a tab.
 *
 * The idea that makes both halves work is the collapse. A strip is
 * one-dimensional, so it cannot draw an arbitrary tree without becoming a
 * puzzle. Rather than flatten the tree to fit the strip, the strip gives up:
 *
 *     [1] [2] [3]      three ordinary tabs
 *     [1 | 2] [3]      N=2 — drawn literally, both tabs on a shared ground
 *     [1 (+2)]         N>=3 — one chip, focused member's label, hover to list
 *     [3 (+2)]         picking 3 from the list moves the label to 3
 *
 * One chip is zero-dimensional, so the tree underneath can be as deep as the
 * user likes and the strip never has to care. N=2 stays literal because 50/50
 * two-pane splits are the case people actually recognise.
 *
 * Three tensions decide whether this ships, and each has a control below.
 *
 *  1. **Nothing may remount.** A live terminal that remounts is a killed pty
 *     and a re-created restty context; CLAUDE.md forbids incidental unmounts
 *     outright. The trap is the obvious tree — panes nested inside the layout
 *     structure — which makes React's parent chain a function of the layout, so
 *     splitting, closing a sibling and restructuring all reparent a pane. The
 *     fix is to decouple three orders that look like one: MOUNT order (by pane
 *     id, never changes), STRIP order (the list of roots), and GEOMETRY (rects
 *     from the tree). Panes live in a flat pool keyed by id and are placed by
 *     CSS alone; the tree is data that produces rects, never structure that
 *     produces mounts. `rearranging: restarts panes` renders the naive tree
 *     instead so you can watch the clocks reset. Every control in here is named
 *     for what it does to the product, not for the React mechanism underneath —
 *     the toggle is the argument, and it is worthless if it has to be explained.
 *
 *     Note the sweep bar is a second, different probe. A CSS animation restarts
 *     when a DOM node is re-inserted, which React does on a keyed *reorder*
 *     without ever remounting the component. React-stable is not DOM-stable and
 *     only DOM-stable is safe for a GPU surface. Portals are the seductive wrong
 *     answer here: changing a portal's container recreates the DOM.
 *
 *  2. **The strip needs three states where it had one.** A tab is now off
 *     screen, on screen, or holding the keyboard. The app's surface ladder is
 *     too finely spaced to carry that alone — adjacent rungs sit a few Lc apart
 *     — so the ladder skips rungs and recruits border, shadow and the accent.
 *     The `contrast` panel measures every step with the real `apcaLc`, in
 *     whichever mode you toggle, rather than asserting it looks fine.
 *
 *  3. **A group is anonymous.** No name, no color, no id you can see. That is
 *     what makes the degenerate case free: `withoutLeaf` collapses a one-child
 *     split back into a leaf, so a group losing members becomes a merged pair
 *     and then an ordinary tab with no ceremony and nothing destroyed.
 *
 * The picker is the same idea applied to creation. It is not a popover anchored
 * to the pane it came from — it is the new pane's own content, so the split
 * lands first and the empty pane asks what it holds. That removes the anchoring
 * and viewport-clamping problem outright (split-down at the bottom edge of the
 * window behaves exactly like split-right), and `withoutLeaf` is already the
 * undo: backing out with Escape collapses the split away again.
 *
 * Deliberately not modelled: real ptys and restty (the lab has no main process
 * — see lab/main.tsx), rename, and dragging a member out of a *collapsed* group
 * (the dropdown offers an eject button instead, which is the better affordance
 * anyway). Judge the interaction.
 */
import {
  ArrowSquareOutIcon,
  ChatCircleIcon,
  ColumnsPlusRightIcon,
  FoldersIcon,
  GitDiffIcon,
  PlusIcon,
  RowsPlusBottomIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import * as React from "react";

import { apcaLc, hexToOklch } from "@volli/shared";

export const title = "Split tabs";
export const note = "Every pane is a tab; a split is a tree the strip collapses past N=2";
export const viewport = "window";

/* ------------------------------------------------------------------ model */

type PaneKind = "chat" | "terminal";
type Axis = "row" | "column";
type Direction = "right" | "down";

interface Pane {
  readonly id: string;
  /** `null` until the picker inside the pane answers "what goes in here?". */
  readonly kind: PaneKind | null;
  readonly label: string;
}

/**
 * The pane tree. `weight` lives on the node rather than in a parallel array on
 * the parent so that adding, removing and moving a child never has to keep two
 * collections in step.
 */
interface Leaf {
  readonly kind: "leaf";
  readonly paneId: string;
  readonly weight: number;
}
interface SplitNode {
  readonly kind: "split";
  readonly id: string;
  readonly axis: Axis;
  readonly weight: number;
  readonly children: readonly TreeNode[];
}
type TreeNode = Leaf | SplitNode;

/**
 * The minimum width at which a pane is still worth having. A terminal wants 80
 * columns; a transcript reflows. It is per-kind, which is also why a
 * chat+terminal split should never open 50/50 — give the terminal its columns
 * and let the transcript take the remainder.
 */
const MIN_WIDTH: Record<PaneKind, number> = { chat: 320, terminal: 440 };
const MIN_HEIGHT = 120;
const MONO_ADVANCE = 7.8;

/**
 * The renderer scales the whole UI, and pointer coordinates come back in client
 * pixels while these floors are authored in CSS pixels. `SplitDivider` in
 * `session-split-layout.tsx` compares the two directly, which is why its drag
 * mistracks at any scale but 100% — the two resize grips in the chrome divide
 * and it does not.
 */
const UI_SCALE = 1;

const SEEDS: readonly Pane[] = [
  { id: "p-auth", kind: "chat", label: "Auth flow rewrite" },
  { id: "p-dev", kind: "terminal", label: "pnpm dev" },
  { id: "p-review", kind: "chat", label: "Migration review" },
  { id: "p-test", kind: "terminal", label: "test:watch" },
  { id: "p-board", kind: "chat", label: "Board perf" },
  { id: "p-log", kind: "terminal", label: "git log --stat" },
  { id: "p-notes", kind: "chat", label: "Release notes" },
  { id: "p-tail", kind: "terminal", label: "tail volli.db" },
];

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

function leavesOf(node: TreeNode): string[] {
  return node.kind === "leaf" ? [node.paneId] : node.children.flatMap(leavesOf);
}

/** A root's stable React key and drag handle — the leaf's pane, or the split itself. */
function rootKey(root: TreeNode): string {
  return root.kind === "leaf" ? root.paneId : root.id;
}

/**
 * Proper window-manager semantics: splitting along an axis the parent already
 * uses adds a sibling rather than nesting a second split inside the first. Miss
 * this and three splits to the right build a right-leaning chain that resizes
 * in a way nobody predicts.
 */
function withSplit(node: TreeNode, targetId: string, axis: Axis, leaf: Leaf): TreeNode | null {
  if (node.kind === "leaf") {
    if (node.paneId !== targetId) return null;
    return {
      kind: "split",
      id: nextId("s"),
      axis,
      weight: node.weight,
      children: [{ ...node, weight: 1 }, leaf],
    };
  }
  const at = node.children.findIndex((child) => child.kind === "leaf" && child.paneId === targetId);
  if (at !== -1 && node.axis === axis) {
    const children = [...node.children];
    children.splice(at + 1, 0, leaf);
    return { ...node, children };
  }
  for (const [index, child] of node.children.entries()) {
    const replaced = withSplit(child, targetId, axis, leaf);
    if (replaced === null) continue;
    const children = [...node.children];
    children[index] = replaced;
    return { ...node, children };
  }
  return null;
}

/** Removing a leaf collapses any split left holding one child. That is Q5, structurally. */
function withoutLeaf(node: TreeNode, paneId: string): TreeNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? null : node;
  const children = node.children
    .map((child) => withoutLeaf(child, paneId))
    .filter((child): child is TreeNode => child !== null);
  if (children.length === 0) return null;
  const only = children[0];
  if (children.length === 1 && only !== undefined) return { ...only, weight: node.weight };
  return { ...node, children };
}

function findSplit(node: TreeNode, splitId: string): SplitNode | null {
  if (node.kind === "leaf") return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child, splitId);
    if (found !== null) return found;
  }
  return null;
}

function withWeights(
  node: TreeNode,
  splitId: string,
  index: number,
  a: number,
  b: number,
): TreeNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) {
    const children = [...node.children];
    const left = children[index];
    const right = children[index + 1];
    if (left === undefined || right === undefined) return node;
    children[index] = { ...left, weight: a };
    children[index + 1] = { ...right, weight: b };
    return { ...node, children };
  }
  return {
    ...node,
    children: node.children.map((child) => withWeights(child, splitId, index, a, b)),
  };
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Placement {
  readonly paneId: string;
  readonly rect: Rect;
}
interface DividerSpec {
  readonly splitId: string;
  readonly index: number;
  readonly axis: Axis;
  readonly rect: Rect;
  readonly span: Rect;
}

const FULL: Rect = { left: 0, top: 0, width: 100, height: 100 };

function layoutTree(
  node: TreeNode,
  rect: Rect,
  places: Placement[],
  dividers: DividerSpec[],
): void {
  if (node.kind === "leaf") {
    places.push({ paneId: node.paneId, rect });
    return;
  }
  const total = node.children.reduce((sum, child) => sum + child.weight, 0);
  let offset = 0;
  node.children.forEach((child, index) => {
    const fraction = child.weight / total;
    const childRect: Rect =
      node.axis === "row"
        ? {
            left: rect.left + offset * rect.width,
            top: rect.top,
            width: fraction * rect.width,
            height: rect.height,
          }
        : {
            left: rect.left,
            top: rect.top + offset * rect.height,
            width: rect.width,
            height: fraction * rect.height,
          };
    layoutTree(child, childRect, places, dividers);
    offset += fraction;
    if (index === node.children.length - 1) return;
    dividers.push({
      splitId: node.id,
      index,
      axis: node.axis,
      span: rect,
      rect:
        node.axis === "row"
          ? {
              left: rect.left + offset * rect.width,
              top: rect.top,
              width: 0,
              height: rect.height,
            }
          : {
              left: rect.left,
              top: rect.top + offset * rect.height,
              width: rect.width,
              height: 0,
            },
    });
  });
}

/** Largest floor among a subtree's leaves — a split is only as narrow as its neediest pane. */
function minExtent(
  node: TreeNode,
  axis: Axis,
  kindOf: (paneId: string) => PaneKind | null,
): number {
  if (axis === "column") return MIN_HEIGHT * UI_SCALE;
  return (
    Math.max(...leavesOf(node).map((paneId) => MIN_WIDTH[kindOf(paneId) ?? "chat"])) * UI_SCALE
  );
}

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A readable sketch of the tree, so you can tell what the split gesture actually built. */
function sketch(node: TreeNode, labelOf: (paneId: string) => string): string {
  if (node.kind === "leaf") return labelOf(node.paneId);
  const glyph = node.axis === "row" ? " | " : " / ";
  return `(${node.children.map((child) => sketch(child, labelOf)).join(glyph)})`;
}

/* ------------------------------------------------- the three-step ladder */

/**
 * Off screen, on screen, focused. The app's surfaces step by only a few Lc
 * between neighbours, so this takes every *other* rung (rail → card → popover)
 * and lets border, shadow and the accent carry what surface alone cannot. The
 * one property that has to hold: with no split up, a lone tab is both on screen
 * and focused, so the strip is indistinguishable from today's.
 */
type Lift = "off" | "on" | "focused";

const LIFT_CLASS: Record<Lift, string> = {
  off: "border-transparent text-muted-foreground hover:bg-accent/40",
  // Off → on is carried by INK, not surface. Muted to full foreground is ~24 Lc;
  // every adjacent pair of surface tokens is below APCA's floor and measures 0.
  on: "border-transparent text-foreground",
  // On → focused is the one surface step worth spending: rail → accent is the
  // widest the token set has, and it moves the same direction in both modes
  // (light's accent is darker than its rail, which is already how the app draws
  // a selected row). Border, shadow and the ember underline carry the rest.
  focused: "border-border-strong bg-accent text-foreground shadow-raised font-medium",
};

/* ------------------------------------------------------------------- pane */

interface PaneBodyProps {
  pane: Pane;
  focused: boolean;
  widthPx: number;
  now: number;
  restarts: number;
  /** Present only while this pane is still waiting to be told what it holds. */
  picker?: {
    rows: readonly PickerRow[];
    onPick(id: string): void;
    onCancel(): void;
  };
  onInstance(paneId: string, token: object): void;
  onFocus(paneId: string): void;
}

/**
 * The unit whose survival is the whole question. In the app this is a restty
 * canvas over a live pty, or a Pi-backed transcript; here it is three probes
 * that make a remount impossible to miss.
 *
 * `token` is a per-*instance* object, not an effect counter: StrictMode
 * double-invokes effects on mount, so counting setups would report a restart
 * that never happened. A fresh instance means a fresh ref, which is exactly the
 * event we care about and the only one StrictMode does not fake.
 */
function PaneBody({
  pane,
  focused,
  widthPx,
  now,
  restarts,
  picker,
  onInstance,
  onFocus,
}: PaneBodyProps): React.JSX.Element {
  const token = React.useRef<object>({});
  const started = React.useRef<number>(Date.now());

  React.useEffect(() => {
    onInstance(pane.id, token.current);
  }, [onInstance, pane.id]);

  const columns = Math.max(0, Math.floor((widthPx - 24) / MONO_ADVANCE));
  const cramped = pane.kind !== null && widthPx > 0 && widthPx < MIN_WIDTH[pane.kind];

  return (
    <div
      role="presentation"
      onMouseDown={() => onFocus(pane.id)}
      className={cx(
        "flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border bg-background transition-colors",
        focused ? "border-primary/70" : "border-border",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5">
        {pane.kind === "terminal" ? (
          <TerminalWindowIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : pane.kind === "chat" ? (
          <ChatCircleIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : null}
        <span
          className={cx(
            "min-w-0 flex-1 truncate text-ui",
            pane.kind === null ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {pane.label}
        </span>
        {pane.kind === "terminal" ? (
          <span
            className={cx(
              "shrink-0 font-mono text-label tabular-nums",
              cramped ? "text-primary-text" : "text-muted-foreground",
            )}
          >
            {columns} cols
          </span>
        ) : null}
      </div>

      <div
        className={cx("min-h-0 flex-1", pane.kind === null ? "" : "overflow-hidden px-2.5 py-2")}
      >
        {picker !== undefined ? (
          <PanePicker rows={picker.rows} onPick={picker.onPick} onCancel={picker.onCancel} />
        ) : pane.kind === "terminal" ? (
          <pre className="truncate font-mono text-label leading-5 text-muted-foreground">
            {"$ pnpm dev\n  ready in 412 ms\n  renderer  :5173\n  main      watching"}
          </pre>
        ) : (
          <div className="flex flex-col gap-1.5">
            <p className="line-clamp-2 text-xs text-muted-foreground">
              Reading src/main/db/migrations to see which index the board query misses.
            </p>
            <div className="h-1 w-2/3 rounded-full bg-muted" />
            <div className="h-1 w-1/2 rounded-full bg-muted" />
          </div>
        )}
      </div>

      {/* The three probes. A reset here is a killed session in the real app. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-2.5 py-1.5">
        <span
          className="font-mono text-label tabular-nums text-muted-foreground"
          title="How long this pane has been running. Back to 00:00 means it was killed and rebuilt."
        >
          {elapsed(now - started.current)}
        </span>
        <span
          className="h-0.5 w-10 shrink-0 overflow-hidden rounded-full bg-muted"
          title="A slower second check. This bar creeps across once and never repeats — if it jumps back to the start, the pane was moved in a way that would reload an embedded view even though the pane itself survived."
        >
          <span
            className="block h-full rounded-full bg-muted-foreground/60"
            style={{ animation: "split-tabs-sweep 24s linear infinite" }}
          />
        </span>
        {restarts > 0 ? (
          <span
            className="shrink-0 rounded-full bg-primary px-1.5 font-mono text-label text-primary-foreground"
            title="This pane restarted. In the real app that is a killed terminal."
          >
            ×{restarts}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- divider */

function Divider({
  spec,
  onDrag,
}: {
  spec: DividerSpec;
  onDrag(clientX: number, clientY: number): void;
}): React.JSX.Element {
  const dragging = React.useRef(false);
  const row = spec.axis === "row";
  return (
    <div
      role="separator"
      aria-orientation={row ? "vertical" : "horizontal"}
      aria-label="Resize panes"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onDrag(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        if (dragging.current) onDrag(event.clientX, event.clientY);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      className={cx(
        "absolute z-20 touch-none",
        row ? "w-2 -translate-x-1/2 cursor-col-resize" : "h-2 -translate-y-1/2 cursor-row-resize",
      )}
      style={{
        left: `${spec.rect.left}%`,
        top: `${spec.rect.top}%`,
        width: row ? undefined : `${spec.rect.width}%`,
        height: row ? `${spec.rect.height}%` : undefined,
      }}
    />
  );
}

/* ------------------------------------------------------------------ picker */

interface PickerRow {
  readonly id: string;
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly hint: string;
  readonly inert?: boolean;
}

/**
 * The Codex pattern: a short stack of rounded rows, an outline icon, a plain
 * label, a right-aligned key hint. No headings and no descriptions — the rows
 * are the explanation.
 *
 * It is the empty pane's *content*, not a popover. The split happens first and
 * the new pane opens with this centred inside it, which is the whole reason it
 * works: there is nothing to anchor, nothing to clamp to the viewport, and
 * split-down near the bottom edge behaves exactly like split-right, because the
 * picker is only ever as big as the hole it was born in.
 *
 * The last two rows are the open question — Codex offers Files and Review,
 * which are not sessions. They are inert here on purpose.
 */
function PanePicker({
  rows,
  onPick,
  onCancel,
}: {
  rows: readonly PickerRow[];
  onPick(id: string): void;
  onCancel(): void;
}): React.JSX.Element {
  const [index, setIndex] = React.useState(0);
  const live = rows.filter((row) => row.inert !== true);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setIndex((current) =>
          Math.min(live.length - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1))),
        );
      } else if (event.key === "Enter") {
        event.preventDefault();
        const row = live[index];
        if (row !== undefined) onPick(row.id);
      } else if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const row = live[Number(event.key) - 1];
        if (row !== undefined) onPick(row.id);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [index, live, onCancel, onPick]);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto p-4">
      <div role="menu" aria-label="Open in this pane" className="my-auto w-full max-w-64">
        {rows.map((row, position) => {
          const liveIndex = live.indexOf(row);
          const selected = liveIndex === index;
          const separated = row.inert === true && rows[position - 1]?.inert !== true;
          return (
            <React.Fragment key={row.id}>
              {separated ? <div className="my-1.5 h-px bg-border" /> : null}
              <button
                type="button"
                role="menuitem"
                disabled={row.inert === true}
                onMouseEnter={() => liveIndex !== -1 && setIndex(liveIndex)}
                onClick={() => onPick(row.id)}
                className={cx(
                  "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors",
                  row.inert === true
                    ? "cursor-default border-transparent text-muted-foreground/60"
                    : selected
                      ? "border-border-strong bg-accent text-foreground"
                      : "border-transparent text-foreground",
                )}
              >
                <span className="shrink-0 text-muted-foreground">{row.icon}</span>
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-label text-muted-foreground">
                  {row.hint}
                </span>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- controls */

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange(value: T): void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-label uppercase text-muted-foreground">{label}</span>
      <div className="flex items-center gap-0.5 rounded-full bg-muted p-0.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            aria-pressed={option === value}
            className="rounded-full px-2 py-0.5 text-label text-muted-foreground transition-colors hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground"
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

interface LadderStep {
  readonly name: string;
  readonly lift: number;
  readonly text: number;
}

/**
 * Scores the ladder off the real generated tokens, in whichever mode is on
 * screen. Two different measures on purpose: APCA is the right tool for ink on
 * a surface and the wrong one for two adjacent surfaces, where it low-clips to
 * a flat 0 and tells you nothing. Surface separation is reported as OKLCh
 * lightness distance from the rail instead, which stays honest at this range.
 */
function measureLadder(): LadderStep[] {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string): string => style.getPropertyValue(name).trim() || "#000000";
  const rail = read("--rail");
  const railL = hexToOklch(rail).L;
  const rows: { name: string; bg: string; fg: string }[] = [
    { name: "hidden", bg: rail, fg: read("--muted-foreground") },
    { name: "showing", bg: rail, fg: read("--foreground") },
    { name: "active", bg: read("--accent"), fg: read("--foreground") },
  ];
  return rows.map((row) => ({
    name: row.name,
    lift: Math.abs(hexToOklch(row.bg).L - railL) * 100,
    text: apcaLc(row.fg, row.bg),
  }));
}

/* ----------------------------------------------------------------- scratch */

interface DropTarget {
  readonly kind: "seam" | "merge";
  readonly index: number;
  readonly x: number;
}

export default function SplitTabsScratch(): React.JSX.Element {
  const [panes, setPanes] = React.useState<Pane[]>(() => SEEDS.slice(0, 4));
  const [roots, setRoots] = React.useState<TreeNode[]>(() => [
    {
      kind: "split",
      id: "s0",
      axis: "row",
      weight: 1,
      children: [
        { kind: "leaf", paneId: "p-auth", weight: 1 },
        { kind: "leaf", paneId: "p-dev", weight: 1 },
      ],
    },
    { kind: "leaf", paneId: "p-review", weight: 1 },
    { kind: "leaf", paneId: "p-test", weight: 1 },
  ]);
  const [focusOrder, setFocusOrder] = React.useState<string[]>(() => ["p-auth"]);
  const [restarts, setRestarts] = React.useState<Record<string, number>>({});

  const [pairStyle, setPairStyle] = React.useState<"boxed" | "plain">("boxed");
  const [splitStyle, setSplitStyle] = React.useState<"instant" | "ask">("ask");
  const [pickerScope, setPickerScope] = React.useState<"3 rows" | "5 rows">("5 rows");
  const [mountModel, setMountModel] = React.useState<"keeps panes alive" | "restarts panes">(
    "keeps panes alive",
  );
  const [mode, setMode] = React.useState<"dark" | "light">("dark");

  const [drag, setDrag] = React.useState<{ paneId: string; dx: number } | null>(null);
  const [drop, setDrop] = React.useState<DropTarget | null>(null);
  /**
   * Measured and drawn `fixed`, not `absolute`. The strip scrolls horizontally,
   * and `overflow-x: auto` computes `overflow-y` to `auto` as well — so a panel
   * hung below a chip inside the scroller is clipped to the 36px strip and never
   * appears. Escaping the clip is the only reason this carries coordinates.
   */
  const [openGroup, setOpenGroup] = React.useState<{
    key: string;
    left: number;
    top: number;
  } | null>(null);
  /**
   * A pane that exists but has not been told what it holds. `from` is the pane
   * the split came out of, so cancelling can put focus back where it started.
   */
  const [pending, setPending] = React.useState<{ paneId: string; from: string } | null>(null);
  const [ladder, setLadder] = React.useState<LadderStep[]>([]);
  const [now, setNow] = React.useState(() => Date.now());
  const [area, setArea] = React.useState({ width: 0, height: 0 });

  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const areaRef = React.useRef<HTMLDivElement | null>(null);
  const seenInstances = React.useRef(new Map<string, object>());
  const hoverTimer = React.useRef<number | null>(null);

  const focusedPaneId = focusOrder[0] ?? "";

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  React.useEffect(() => {
    const node = areaRef.current;
    if (node === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setArea({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Scoped to this scratch and undone on unmount — the lab has no theme picker
  // any more, and a dev-tool preference that outlived its editor would just be
  // a way to make the lab lie.
  React.useEffect(() => {
    if (mode !== "light") return;
    document.documentElement.classList.add("light");
    return () => document.documentElement.classList.remove("light");
  }, [mode]);

  React.useEffect(() => {
    // After the class lands, so the measurement reads the mode on screen.
    const id = window.requestAnimationFrame(() => setLadder(measureLadder()));
    return () => window.cancelAnimationFrame(id);
  }, [mode]);

  const registerInstance = React.useCallback((paneId: string, token: object) => {
    const previous = seenInstances.current.get(paneId);
    seenInstances.current.set(paneId, token);
    if (previous !== undefined && previous !== token) {
      setRestarts((current) => ({ ...current, [paneId]: (current[paneId] ?? 0) + 1 }));
    }
  }, []);

  const paneById = React.useMemo(
    () => new Map(panes.map((pane): [string, Pane] => [pane.id, pane])),
    [panes],
  );
  const kindOf = React.useCallback(
    (paneId: string): PaneKind => paneById.get(paneId)?.kind ?? "chat",
    [paneById],
  );
  const labelOf = React.useCallback(
    (paneId: string): string => paneById.get(paneId)?.label ?? paneId,
    [paneById],
  );

  /** The root holding focus. Visibility is derived from focus, never stored beside it. */
  const activeRoot = React.useMemo(
    () => roots.find((root) => leavesOf(root).includes(focusedPaneId)) ?? roots[0] ?? null,
    [roots, focusedPaneId],
  );

  const { places, dividers } = React.useMemo(() => {
    const nextPlaces: Placement[] = [];
    const nextDividers: DividerSpec[] = [];
    if (activeRoot !== null) layoutTree(activeRoot, FULL, nextPlaces, nextDividers);
    return { places: nextPlaces, dividers: nextDividers };
  }, [activeRoot]);

  const rectByPane = React.useMemo(
    () => new Map(places.map((place): [string, Rect] => [place.paneId, place.rect])),
    [places],
  );

  const focusPane = React.useCallback((paneId: string) => {
    setFocusOrder((current) => [paneId, ...current.filter((id) => id !== paneId)]);
  }, []);

  /** The member whose label a collapsed chip wears: the one focused most recently. */
  const representativeOf = React.useCallback(
    (root: TreeNode): string => {
      const members = leavesOf(root);
      return focusOrder.find((paneId) => members.includes(paneId)) ?? members[0] ?? "";
    },
    [focusOrder],
  );

  /* ---------------------------------------------------------- commands */

  const nextSeed = React.useCallback(
    (kind: PaneKind): Pane => {
      const used = new Set(panes.map((pane) => pane.id));
      return (
        SEEDS.find((seed) => seed.kind === kind && !used.has(seed.id)) ?? {
          id: nextId("p-"),
          kind,
          label: kind === "terminal" ? "zsh" : "New chat",
        }
      );
    },
    [panes],
  );

  /**
   * `kind: null` opens the pane empty and lets the picker inside it decide. The
   * split lands either way — that is the point of moving the picker into the
   * pane, and it is why there is no anchoring or viewport maths left anywhere.
   */
  const splitFocused = React.useCallback(
    (kind: PaneKind | null, direction: Direction) => {
      const pane: Pane =
        kind === null ? { id: nextId("p-"), kind: null, label: "New pane" } : nextSeed(kind);
      const leaf: Leaf = { kind: "leaf", paneId: pane.id, weight: 1 };
      const axis: Axis = direction === "right" ? "row" : "column";
      const at = roots.findIndex((root) => leavesOf(root).includes(focusedPaneId));
      const target = roots[at];
      if (target === undefined) return;
      const replaced = withSplit(target, focusedPaneId, axis, leaf);
      if (replaced === null) return;
      const nextRoots = [...roots];
      nextRoots[at] = replaced;
      // The pool is appended to, never spliced by position: its order is
      // identity, not layout, and the no-remount guarantee rests on it.
      setPanes([...panes, pane]);
      setRoots(nextRoots);
      if (kind === null) setPending({ paneId: pane.id, from: focusedPaneId });
      focusPane(pane.id);
    },
    [focusPane, focusedPaneId, nextSeed, panes, roots],
  );

  /**
   * Answering the picker fills the pane in place — same id, same position in the
   * pool, so the pane host never rebuilds. The clock in the footer keeps running
   * across the choice, which is the behaviour the real thing needs too.
   */
  const choosePending = React.useCallback(
    (kind: PaneKind) => {
      if (pending === null) return;
      const used = new Set(panes.map((pane) => pane.id));
      const seed = SEEDS.find((candidate) => candidate.kind === kind && !used.has(candidate.id));
      setPanes(
        panes.map((pane) =>
          pane.id === pending.paneId
            ? {
                ...pane,
                kind,
                label: seed?.label ?? (kind === "terminal" ? "zsh" : "New chat"),
              }
            : pane,
        ),
      );
      setPending(null);
    },
    [panes, pending],
  );

  const pickInPane = React.useCallback(
    (id: string) => {
      // "Existing session" would open a second-level list in the real thing; it
      // resolves to a chat here so the row is not dead in the lab.
      if (id === "terminal") choosePending("terminal");
      else if (id === "chat" || id === "existing") choosePending("chat");
    },
    [choosePending],
  );

  const openTab = React.useCallback(
    (kind: PaneKind) => {
      const pane = nextSeed(kind);
      setPanes([...panes, pane]);
      setRoots([...roots, { kind: "leaf", paneId: pane.id, weight: 1 }]);
      focusPane(pane.id);
    },
    [focusPane, nextSeed, panes, roots],
  );

  const closePane = React.useCallback(
    (paneId: string) => {
      const at = roots.findIndex((root) => leavesOf(root).includes(paneId));
      if (at === -1) return;
      const target = roots[at];
      if (target === undefined) return;
      // Focus stays inside the split it was in — losing a pane must not also
      // lose your place.
      const sibling = leavesOf(target).find((id) => id !== paneId);
      const replaced = withoutLeaf(target, paneId);
      const nextRoots = [...roots];
      if (replaced === null) nextRoots.splice(at, 1);
      else nextRoots[at] = replaced;
      setRoots(nextRoots);
      setPanes(panes.filter((pane) => pane.id !== paneId));
      setFocusOrder((current) => {
        const pruned = current.filter((id) => id !== paneId);
        if (current[0] !== paneId) return pruned;
        const fallback =
          sibling ?? leavesOf(nextRoots[Math.min(at, nextRoots.length - 1)] ?? target)[0];
        return fallback === undefined
          ? pruned
          : [fallback, ...pruned.filter((id) => id !== fallback)];
      });
    },
    [panes, roots],
  );

  /** Pops a member out of its group into a standalone tab. The inverse of a merge. */
  const ejectPane = React.useCallback(
    (paneId: string) => {
      const at = roots.findIndex((root) => leavesOf(root).includes(paneId));
      const target = roots[at];
      if (target === undefined || target.kind === "leaf") return;
      const replaced = withoutLeaf(target, paneId);
      const nextRoots = [...roots];
      if (replaced === null) nextRoots.splice(at, 1);
      else nextRoots[at] = replaced;
      nextRoots.splice(at + 1, 0, { kind: "leaf", paneId, weight: 1 });
      setRoots(nextRoots);
      focusPane(paneId);
      setOpenGroup(null);
    },
    [focusPane, roots],
  );

  /**
   * Backing out of the picker undoes the split. An empty pane is not a state
   * anyone wants to be left holding, and "split into X" without an X was not a
   * split. `withoutLeaf` collapses the parent back to a plain leaf, so the
   * layout is exactly what it was and focus returns to the pane you split from.
   */
  const cancelPending = React.useCallback(() => {
    if (pending === null) return;
    const { paneId, from } = pending;
    const at = roots.findIndex((root) => leavesOf(root).includes(paneId));
    const target = roots[at];
    setPending(null);
    setPanes(panes.filter((pane) => pane.id !== paneId));
    if (target !== undefined) {
      const replaced = withoutLeaf(target, paneId);
      const nextRoots = [...roots];
      if (replaced === null) nextRoots.splice(at, 1);
      else nextRoots[at] = replaced;
      setRoots(nextRoots);
    }
    setFocusOrder((current) => [from, ...current.filter((id) => id !== from && id !== paneId)]);
  }, [panes, pending, roots]);

  // Clicking any other pane or tab is also a dismissal. Watching focus rather
  // than wiring this into every click path means there is one rule, not five.
  React.useEffect(() => {
    if (pending !== null && focusedPaneId !== pending.paneId) cancelPending();
  }, [cancelPending, focusedPaneId, pending]);

  const requestSplit = React.useCallback(
    (direction: Direction) => {
      splitFocused(splitStyle === "ask" ? null : kindOf(focusedPaneId), direction);
    },
    [focusedPaneId, kindOf, splitFocused, splitStyle],
  );

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // While a pane is waiting to be filled, the picker inside it owns the
      // keyboard — digits, arrows and Escape all belong to it.
      if (!event.metaKey || pending !== null) return;
      if (event.key === "d") {
        event.preventDefault();
        requestSplit(event.altKey ? "down" : "right");
      } else if (event.key === "t") {
        event.preventDefault();
        openTab(event.altKey ? "chat" : "terminal");
      } else if (event.key === "w") {
        event.preventDefault();
        closePane(focusedPaneId);
      } else if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const root = roots[Number(event.key) - 1];
        if (root !== undefined) focusPane(representativeOf(root));
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    closePane,
    focusPane,
    focusedPaneId,
    openTab,
    pending,
    representativeOf,
    requestSplit,
    roots,
  ]);

  /* -------------------------------------------------------------- drag */

  const resolveDrop = React.useCallback((clientX: number, draggedId: string): DropTarget | null => {
    const scroller = scrollerRef.current;
    if (scroller === null) return null;
    const box = scroller.getBoundingClientRect();
    const entries = [...scroller.querySelectorAll<HTMLElement>("[data-root-id]")].filter(
      (element) => element.dataset.rootId !== draggedId,
    );
    const toLocal = (x: number): number => x - box.left + scroller.scrollLeft;
    for (const [index, element] of entries.entries()) {
      const rect = element.getBoundingClientRect();
      const third = rect.width / 3;
      if (clientX >= rect.left + third && clientX <= rect.right - third) {
        return { kind: "merge", index, x: toLocal(rect.left + rect.width / 2) };
      }
      if (clientX < rect.left + third) return { kind: "seam", index, x: toLocal(rect.left) };
    }
    const last = entries.at(-1);
    return {
      kind: "seam",
      index: entries.length,
      x: last === undefined ? 0 : toLocal(last.getBoundingClientRect().right),
    };
  }, []);

  const dragOrigin = React.useRef(0);
  const pressed = React.useRef<{
    rootId: string;
    paneId: string;
    chip: HTMLElement | null;
  } | null>(null);

  function onStripPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest("[data-inert]") !== null) return;
    const rootElement = target.closest<HTMLElement>("[data-root-id]");
    const tabElement = target.closest<HTMLElement>("[data-pane-id]");
    const rootId = rootElement?.dataset.rootId;
    const paneId = tabElement?.dataset.paneId;
    if (rootId === undefined || paneId === undefined || tabElement === null) return;
    // Capture on the scroller, not the tab: a tab can be re-keyed into or out of
    // a group enclosure mid-drag, and capture on a node that can disappear is a
    // drag that dies halfway.
    event.currentTarget.setPointerCapture(event.pointerId);
    pressed.current = {
      rootId,
      paneId,
      chip: tabElement.dataset.chip === undefined ? null : (tabElement.parentElement ?? tabElement),
    };
    dragOrigin.current = event.clientX;
  }

  function onStripPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const press = pressed.current;
    if (press === null) return;
    const dx = event.clientX - dragOrigin.current;
    if (drag === null && Math.abs(dx) < 6) return; // hysteresis, so a click stays a click
    setDrag({ paneId: press.rootId, dx });
    setDrop(resolveDrop(event.clientX, press.rootId));
  }

  function onStripPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const press = pressed.current;
    pressed.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (press === null) return;
    const rootId = press.rootId;
    if (drag === null) {
      // Selection happens HERE, not in an onClick on the tab. Capturing the
      // pointer on the scroller makes the browser retarget the click to the
      // capturing element, so a handler on the tab itself simply never fires —
      // the tabs looked interactive and were not.
      focusPane(press.paneId);
      if (press.chip !== null) {
        const box = press.chip.getBoundingClientRect();
        setOpenGroup({ key: rootId, left: box.left, top: box.bottom + 4 });
      }
    }
    if (drag !== null && drop !== null) {
      const at = roots.findIndex((root) => rootKey(root) === rootId);
      const moving = roots[at];
      if (moving !== undefined) {
        const rest = roots.filter((_, index) => index !== at);
        if (drop.kind === "merge") {
          const host = rest[drop.index];
          if (host !== undefined) {
            // Merging defaults to a column beside — the 50/50 two-pane split is
            // the shape people recognise; deeper geometry comes from splitting.
            rest[drop.index] = {
              kind: "split",
              id: nextId("s"),
              axis: "row",
              weight: host.weight,
              children: [
                { ...host, weight: 1 },
                { ...moving, weight: 1 },
              ],
            };
          }
        } else {
          rest.splice(drop.index, 0, moving);
        }
        setRoots(rest);
      }
    }
    setDrag(null);
    setDrop(null);
  }

  /* ------------------------------------------------------------ resize */

  const resize = React.useCallback(
    (spec: DividerSpec, clientX: number, clientY: number) => {
      const node = areaRef.current;
      if (node === null || activeRoot === null) return;
      const split = findSplit(activeRoot, spec.splitId);
      if (split === null) return;
      const box = node.getBoundingClientRect();
      const row = spec.axis === "row";
      // Measured off the live element, so this is already in the same coordinate
      // space as the pointer; only the authored floors need the scale applied.
      const spanPx = row
        ? (spec.span.width / 100) * box.width
        : (spec.span.height / 100) * box.height;
      const originPx = row
        ? box.left + (spec.span.left / 100) * box.width
        : box.top + (spec.span.top / 100) * box.height;
      const total = split.children.reduce((sum, child) => sum + child.weight, 0);
      const before = split.children
        .slice(0, spec.index)
        .reduce((sum, child) => sum + child.weight, 0);
      const first = split.children[spec.index];
      const second = split.children[spec.index + 1];
      if (first === undefined || second === undefined) return;
      const pair = first.weight + second.weight;
      const pairPx = (pair / total) * spanPx;
      const minFirst = minExtent(first, spec.axis, kindOf);
      const minSecond = minExtent(second, spec.axis, kindOf);
      const raw = (row ? clientX : clientY) - originPx - (before / total) * spanPx;
      const clamped = Math.min(Math.max(raw, minFirst), Math.max(minFirst, pairPx - minSecond));
      const share = (clamped / Math.max(pairPx, 1)) * pair;
      const at = roots.findIndex((root) => root === activeRoot);
      if (at === -1) return;
      const nextRoots = [...roots];
      nextRoots[at] = withWeights(
        activeRoot,
        spec.splitId,
        spec.index,
        Math.max(0.05, share),
        Math.max(0.05, pair - share),
      );
      setRoots(nextRoots);
    },
    [activeRoot, kindOf, roots],
  );

  /* ------------------------------------------------------------- render */

  const pickerRows: PickerRow[] = React.useMemo(() => {
    const sessions: PickerRow[] = [
      { id: "chat", label: "New chat", icon: <ChatCircleIcon className="size-4" />, hint: "1" },
      {
        id: "terminal",
        label: "New terminal",
        icon: <TerminalWindowIcon className="size-4" />,
        hint: "2",
      },
      {
        id: "existing",
        label: "Existing session…",
        icon: <ArrowSquareOutIcon className="size-4" />,
        hint: "3",
      },
    ];
    if (pickerScope === "3 rows") return sessions;
    return [
      ...sessions,
      {
        id: "files",
        label: "Files",
        icon: <FoldersIcon className="size-4" />,
        hint: "4",
        inert: true,
      },
      {
        id: "changes",
        label: "Changes",
        icon: <GitDiffIcon className="size-4" />,
        hint: "5",
        inert: true,
      },
    ];
  }, [pickerScope]);

  const totalRestarts = Object.values(restarts).reduce((sum, count) => sum + count, 0);
  const widthOf = (rect: Rect | undefined): number =>
    rect === undefined ? 0 : (rect.width / 100) * area.width;

  function renderTab(paneId: string, lift: Lift, suffix?: string): React.JSX.Element | null {
    const pane = paneById.get(paneId);
    if (pane === undefined) return null;
    return (
      <>
        {/* A pane still being chosen has no icon — the gap is the signal. */}
        {pane.kind === "terminal" ? (
          <TerminalWindowIcon className={cx("size-3.5 shrink-0", lift === "off" && "opacity-70")} />
        ) : pane.kind === "chat" ? (
          <ChatCircleIcon className={cx("size-3.5 shrink-0", lift === "off" && "opacity-70")} />
        ) : null}
        <span className={cx("max-w-40 truncate", pane.kind === null && "italic opacity-70")}>
          {pane.label}
        </span>
        {suffix !== undefined ? (
          <span className="shrink-0 font-mono text-label opacity-70">{suffix}</span>
        ) : null}
        <button
          type="button"
          data-inert
          aria-label={`Close ${pane.label}`}
          onClick={() => closePane(paneId)}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-border focus-visible:opacity-100"
        >
          <XIcon className="size-3" weight="bold" />
        </button>
      </>
    );
  }

  return (
    <div className="flex h-svh w-full flex-col bg-rail text-foreground">
      <style>{`@keyframes split-tabs-sweep { from { width: 0% } to { width: 100% } }`}</style>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2">
        <Choice
          label="two panes"
          value={pairStyle}
          options={["boxed", "plain"] as const}
          onChange={(next) => setPairStyle(next)}
        />
        <Choice
          label="splitting"
          value={splitStyle}
          options={["instant", "ask"] as const}
          onChange={(next) => setSplitStyle(next)}
        />
        <Choice
          label="picker"
          value={pickerScope}
          options={["3 rows", "5 rows"] as const}
          onChange={(next) => setPickerScope(next)}
        />
        <Choice
          label="rearranging"
          value={mountModel}
          options={["keeps panes alive", "restarts panes"] as const}
          onChange={(next) => setMountModel(next)}
        />
        <Choice
          label="mode"
          value={mode}
          options={["dark", "light"] as const}
          onChange={(next) => setMode(next)}
        />
        <span className="flex items-center gap-1.5 font-mono text-label uppercase text-muted-foreground">
          panes restarted
          <span
            className={cx(
              "rounded-full px-1.5 tabular-nums",
              totalRestarts > 0 ? "bg-primary text-primary-foreground" : "bg-muted",
            )}
          >
            {totalRestarts}
          </span>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {ladder.map((step) => (
            <span
              key={step.name}
              className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-label tabular-nums text-muted-foreground"
              title={`${step.name} — surface lift from the rail (OKLCh L ×100), then ink on that surface (APCA Lc)`}
            >
              <span className="text-foreground">{step.name}</span>
              {step.lift.toFixed(1)}·{step.text.toFixed(1)}
            </span>
          ))}
        </div>
      </div>

      {/* The one line of prose in here, because the toggle above it is the whole
          point of the scratch and its stake is not visible from the control. */}
      <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        Rearranging panes must not restart a running terminal. The two settings above build the same
        layout two ways — one survives being rearranged, the other kills the process. Watch each
        pane&rsquo;s timer.
      </p>

      <div className="m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
        {/* --------------------------------------------------------- strip */}
        <div className="flex h-9 shrink-0 items-center border-b border-border bg-rail px-2">
          <div
            ref={scrollerRef}
            role="tablist"
            aria-label="Panes"
            onPointerDown={onStripPointerDown}
            onPointerMove={onStripPointerMove}
            onPointerUp={onStripPointerUp}
            onPointerCancel={onStripPointerUp}
            className="relative flex min-w-0 flex-1 items-center gap-1.5 touch-none overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {roots.map((root) => {
              const key = rootKey(root);
              const members = leavesOf(root);
              const onScreen = root === activeRoot;
              const dragged = drag?.paneId === key;
              const merging =
                drop?.kind === "merge" &&
                roots.filter((other) => rootKey(other) !== drag?.paneId)[drop.index] === root;
              const shared = cx(
                "group relative flex h-7 shrink-0 select-none items-center gap-1.5 rounded-md border pr-1 pl-2.5 text-ui outline-none",
                "transition-[background-color,border-color,box-shadow,color] duration-150 ease-out",
                dragged && "z-10 cursor-grabbing opacity-90 shadow-card",
                merging && "ring-2 ring-primary/70",
              );
              const style = dragged ? { transform: `translateX(${drag.dx}px)` } : undefined;

              /* N=1 — an ordinary tab. */
              if (members.length === 1) {
                const paneId = members[0] ?? "";
                const lift: Lift = onScreen ? "focused" : "off";
                return (
                  <div
                    key={key}
                    role="tab"
                    aria-selected={onScreen}
                    data-root-id={key}
                    data-pane-id={paneId}
                    style={style}
                    className={cx(
                      shared,
                      LIFT_CLASS[lift],
                      lift === "focused" && "shadow-[inset_0_-2px_0_0_var(--color-primary)]",
                    )}
                  >
                    {renderTab(paneId, lift)}
                  </div>
                );
              }

              /* N=2 — drawn literally: both tabs, one enclosure. */
              if (members.length === 2) {
                return (
                  <div
                    key={key}
                    data-root-id={key}
                    style={style}
                    className={cx(
                      "relative flex shrink-0 items-center rounded-md border",
                      pairStyle === "boxed" ? "border-border bg-card p-px" : "border-transparent",
                      dragged && "z-10 opacity-90 shadow-card",
                      merging && "ring-2 ring-primary/70",
                    )}
                  >
                    {members.map((paneId, index) => {
                      const focused = paneId === focusedPaneId;
                      const lift: Lift = focused ? "focused" : onScreen ? "on" : "off";
                      return (
                        <div
                          key={paneId}
                          role="tab"
                          aria-selected={focused}
                          data-pane-id={paneId}
                          className={cx(
                            "group relative flex h-7 shrink-0 select-none items-center gap-1.5 border-y border-r pr-1 pl-2.5 text-ui",
                            "transition-[background-color,border-color,color] duration-150 ease-out",
                            index === 0 ? "rounded-l-[5px] border-l" : "rounded-r-[5px]",
                            LIFT_CLASS[lift],
                            focused && "shadow-[inset_0_-2px_0_0_var(--color-primary)]",
                          )}
                        >
                          {renderTab(paneId, lift)}
                        </div>
                      );
                    })}
                  </div>
                );
              }

              /* N>=3 — the strip stops trying. One chip, hover to list. */
              const representative = representativeOf(root);
              const lift: Lift = onScreen ? "focused" : "off";
              const open = openGroup?.key === key;
              const openAt = (element: HTMLElement): void => {
                const box = element.getBoundingClientRect();
                setOpenGroup({ key, left: box.left, top: box.bottom + 4 });
              };
              return (
                <div
                  key={key}
                  data-root-id={key}
                  style={style}
                  onMouseEnter={(event) => {
                    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
                    openAt(event.currentTarget);
                  }}
                  onMouseLeave={() => {
                    hoverTimer.current = window.setTimeout(() => setOpenGroup(null), 160);
                  }}
                  className="relative shrink-0"
                >
                  <div
                    role="tab"
                    aria-selected={onScreen}
                    aria-expanded={open}
                    data-pane-id={representative}
                    // `data-chip` tells the strip's pointer-up that pressing this
                    // should also open the list, so a click both brings the group
                    // forward and shows what is in it — no hover required.
                    data-chip=""
                    className={cx(
                      shared,
                      LIFT_CLASS[lift],
                      lift === "focused" && "shadow-[inset_0_-2px_0_0_var(--color-primary)]",
                    )}
                  >
                    {renderTab(representative, lift, `+${members.length - 1}`)}
                  </div>

                  {open ? (
                    <div
                      data-inert
                      className="fixed z-50 w-56 rounded-lg border border-border bg-popover p-1 shadow-overlay"
                      style={{ left: openGroup.left, top: openGroup.top }}
                    >
                      {members.map((paneId) => {
                        const pane = paneById.get(paneId);
                        if (pane === undefined) return null;
                        const focused = paneId === focusedPaneId;
                        return (
                          <div
                            key={paneId}
                            className={cx(
                              "group flex items-center gap-2 rounded-md px-2 py-1.5 text-ui transition-colors",
                              focused
                                ? "bg-accent text-foreground"
                                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => focusPane(paneId)}
                              className="flex min-w-0 flex-1 items-center gap-2 text-left"
                            >
                              {pane.kind === "terminal" ? (
                                <TerminalWindowIcon className="size-3.5 shrink-0" />
                              ) : (
                                <ChatCircleIcon className="size-3.5 shrink-0" />
                              )}
                              <span className="truncate">{pane.label}</span>
                            </button>
                            <button
                              type="button"
                              aria-label={`Move ${pane.label} out of the split`}
                              onClick={() => ejectPane(paneId)}
                              className="flex size-5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-border"
                            >
                              <ArrowSquareOutIcon className="size-3" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Close ${pane.label}`}
                              onClick={() => closePane(paneId)}
                              className="flex size-5 shrink-0 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover:opacity-100 hover:bg-border"
                            >
                              <XIcon className="size-3" weight="bold" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {drop?.kind === "seam" && drag !== null ? (
              <span
                className="pointer-events-none absolute top-0.5 bottom-0.5 z-30 w-0.5 -translate-x-1/2 rounded-full bg-primary"
                style={{ left: drop.x }}
              />
            ) : null}
          </div>

          {/* The end-of-tabs mark. Without it these read as members of a
              trailing group, since an enclosure has no other right edge. */}
          <div className="ml-2 flex shrink-0 items-center gap-1 border-l border-border pl-2">
            <button
              type="button"
              onClick={() => openTab("terminal")}
              className="flex h-6 items-center gap-1 rounded-full px-2 text-label text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PlusIcon className="size-3" weight="bold" />
              tab
            </button>
            <button
              type="button"
              aria-label="Split right"
              onClick={() => requestSplit("right")}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ColumnsPlusRightIcon className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Split down"
              onClick={() => requestSplit("down")}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RowsPlusBottomIcon className="size-4" />
            </button>
          </div>
        </div>

        {/* ---------------------------------------------------------- panes */}
        <div ref={areaRef} className="relative min-h-0 flex-1 p-1.5">
          {mountModel === "keeps panes alive"
            ? // Every open pane, once, in creation order, positioned by CSS. The
              // children array never reorders, so React never moves a fiber and
              // the browser never re-inserts a node.
              panes.map((pane) => {
                const rect = rectByPane.get(pane.id);
                return (
                  <div
                    key={pane.id}
                    className={cx("absolute p-0.5", rect === undefined && "hidden")}
                    style={
                      rect === undefined
                        ? undefined
                        : {
                            left: `${rect.left}%`,
                            top: `${rect.top}%`,
                            width: `${rect.width}%`,
                            height: `${rect.height}%`,
                          }
                    }
                  >
                    <PaneBody
                      pane={pane}
                      focused={pane.id === focusedPaneId}
                      widthPx={widthOf(rect)}
                      now={now}
                      restarts={restarts[pane.id] ?? 0}
                      picker={
                        pending?.paneId === pane.id
                          ? { rows: pickerRows, onPick: pickInPane, onCancel: cancelPending }
                          : undefined
                      }
                      onInstance={registerInstance}
                      onFocus={focusPane}
                    />
                  </div>
                );
              })
            : // The naive tree every layout library builds: the parent chain
              // follows the layout, and only the visible root exists. Splitting a
              // pane, closing its sibling or switching roots all rebuild it.
              activeRoot !== null && (
                <NaiveNode
                  node={activeRoot}
                  rect={FULL}
                  paneById={paneById}
                  focusedPaneId={focusedPaneId}
                  areaWidth={area.width}
                  now={now}
                  restarts={restarts}
                  pendingPaneId={pending?.paneId ?? null}
                  pickerRows={pickerRows}
                  onPick={pickInPane}
                  onCancelPending={cancelPending}
                  onInstance={registerInstance}
                  onFocus={focusPane}
                />
              )}

          {dividers.map((spec) => (
            <Divider
              key={`${spec.splitId}:${spec.index}`}
              spec={spec}
              onDrag={(clientX, clientY) => resize(spec, clientX, clientY)}
            />
          ))}
        </div>

        <div className="shrink-0 border-t border-border px-3 py-1.5 font-mono text-label text-muted-foreground">
          {activeRoot === null ? "—" : sketch(activeRoot, labelOf)}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ naive tree */

interface NaiveNodeProps {
  node: TreeNode;
  rect: Rect;
  paneById: Map<string, Pane>;
  focusedPaneId: string;
  areaWidth: number;
  now: number;
  restarts: Record<string, number>;
  pendingPaneId: string | null;
  pickerRows: readonly PickerRow[];
  onPick(id: string): void;
  onCancelPending(): void;
  onInstance(paneId: string, token: object): void;
  onFocus(paneId: string): void;
}

function NaiveNode({
  node,
  rect,
  paneById,
  focusedPaneId,
  areaWidth,
  now,
  restarts,
  pendingPaneId,
  pickerRows,
  onPick,
  onCancelPending,
  onInstance,
  onFocus,
}: NaiveNodeProps): React.JSX.Element | null {
  const style = {
    left: `${rect.left}%`,
    top: `${rect.top}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
  };
  if (node.kind === "leaf") {
    const pane = paneById.get(node.paneId);
    if (pane === undefined) return null;
    return (
      <div className="absolute p-0.5" style={style}>
        <PaneBody
          pane={pane}
          focused={pane.id === focusedPaneId}
          widthPx={(rect.width / 100) * areaWidth}
          now={now}
          restarts={restarts[pane.id] ?? 0}
          picker={
            pendingPaneId === pane.id
              ? { rows: pickerRows, onPick, onCancel: onCancelPending }
              : undefined
          }
          onInstance={onInstance}
          onFocus={onFocus}
        />
      </div>
    );
  }
  const total = node.children.reduce((sum, child) => sum + child.weight, 0);
  let offset = 0;
  return (
    <div className="absolute" style={style}>
      {node.children.map((child) => {
        const fraction = child.weight / total;
        const childRect: Rect =
          node.axis === "row"
            ? { left: offset * 100, top: 0, width: fraction * 100, height: 100 }
            : { left: 0, top: offset * 100, width: 100, height: fraction * 100 };
        offset += fraction;
        return (
          <NaiveNode
            key={child.kind === "leaf" ? child.paneId : child.id}
            node={child}
            rect={childRect}
            paneById={paneById}
            focusedPaneId={focusedPaneId}
            areaWidth={
              node.axis === "row"
                ? (fraction * rect.width * areaWidth) / 100
                : (rect.width * areaWidth) / 100
            }
            now={now}
            restarts={restarts}
            pendingPaneId={pendingPaneId}
            pickerRows={pickerRows}
            onPick={onPick}
            onCancelPending={onCancelPending}
            onInstance={onInstance}
            onFocus={onFocus}
          />
        );
      })}
    </div>
  );
}
