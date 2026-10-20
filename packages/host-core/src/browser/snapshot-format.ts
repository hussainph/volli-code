/**
 * The accessibility-snapshot printer: CDP's `Accessibility.getFullAXTree`
 * answer in, the ref-bearing text a model reads out.
 *
 * The dialect is Playwright MCP's — `- role "name" [ref=eN]` lines, children
 * indented under a trailing colon — adopted as a format spec rather than
 * vendored code (see the VC-110 decision comment). The hard half of a
 * snapshot, computing roles and
 * accessible names, is not done here at all: Chromium already resolved both
 * before the tree crossed the debugger, so this module only decides what is
 * worth a line, what earns a ref, and where the bound falls.
 *
 * Refs are the interaction contract. The map they resolve through — ref to
 * `backendDOMNodeId` — is returned beside the text so the controller can
 * dispatch real input at the element the model named. Identity is stable
 * within one navigation generation (VC-364): the controller hands each print
 * a {@link RefLedger} of what earlier reads of the generation printed, the
 * same backend node prints under the same `eN`, and only an element no
 * earlier read showed gets a fresh number, in document order — and, once the
 * generation has been read before, Volli's `[new]` mark. Which refs are
 * ACTIONABLE is still only what this print shows: the ledger is history, the
 * returned `refs` map is the gate. Generation bookkeeping lives with the
 * controller, which is the party that knows when a page changed.
 *
 * Two prints share one traversal: {@link formatAXSnapshot}, the whole tree
 * under a character bound, and {@link formatAXFind}, a bounded literal search
 * that prints only matching subtrees under their path from the root, with
 * Volli's `...` line where it left something out.
 *
 * Everything printed here is page-derived and therefore untrusted. The
 * envelope that says so belongs to the runtime's browser tools; this module's
 * obligation is only to keep the shape Volli's — one node per line, names
 * quoted, no line a page's text can fake its way out of (newlines in names
 * are collapsed before printing). Every Volli-authored token — `[ref=eN]`,
 * `[new]`, `[match]`, `[level=N]`, a trailing colon, a `...` line — is decided
 * from structure and printed outside the quotes; nothing is ever re-read out
 * of the printed text, where a page's name could have planted a lookalike.
 */

import { createHash } from "node:crypto";

import type { RuntimeWholeText } from "@volli/shared";

/** A CDP AXNode, cut to the fields this printer reads. */
export interface AXNodeLike {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  /** The element's current value — a field's text, a slider's position. Read only by the digest. */
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/**
 * What earlier reads of the current generation printed, as the controller
 * hands it to the next print. History, not permission: a ref here names the
 * element it named before, but only a ref the new print shows is actionable.
 */
export interface RefLedger {
  /** backendDOMNodeId to the `eN` an earlier read of this generation printed for it. */
  known: ReadonlyMap<number, string>;
  /** The number the next element no read has shown will get. */
  nextRef: number;
  /**
   * Whether an earlier read of this generation showed the reader any element.
   * Only then can one be new to them: on a first read everything is, and
   * marking all of it says nothing.
   */
  markNew: boolean;
}

/** One printed snapshot: the text, the handles its refs resolve to, and the bound's verdict. */
export interface BrowserSnapshotFormat {
  text: string;
  /** `eN` to the CDP backendDOMNodeId input is dispatched at — exactly the refs the text shows. */
  refs: ReadonlyMap<string, number>;
  /**
   * `eN` to the accessible name printed beside it (VC-238), so an action can
   * be reported by what the page calls the element. Page content, already cut
   * to the name bound; empty names are absent rather than `""`.
   */
  names: ReadonlyMap<string, string>;
  /**
   * The number the next unseen element will get. Advanced only by refs the
   * text shows: a number minted on a line the bound cut away was never shown,
   * so it is not remembered and not reserved.
   */
  nextRef: number;
  truncated: boolean;
  /**
   * Whether the tree exposed nothing at all — which is not the same as a cut
   * that left no room to print, or (for a find) as matching nothing.
   */
  empty: boolean;
}

/** One bounded search: the matching subtrees, and the counts Volli states beside them. */
export interface BrowserFindFormat extends BrowserSnapshotFormat {
  /** Every match the search found, printed or not. */
  matches: number;
  /** The matches the text shows. */
  shown: number;
}

/**
 * The default character bound. Snapshots exist to be cheaper than screenshots;
 * an unbounded print of a pathological page would spend the budget the format
 * was chosen to save.
 */
export const SNAPSHOT_MAX_CHARS = 30_000;
const SNAPSHOT_MAX_NODES = 2_000;
const SNAPSHOT_MAX_TREE_DEPTH = 128;
const SNAPSHOT_MAX_NODE_NAME_CHARS = 1_000;

/**
 * A find's bounds. It walks far more of the tree than a snapshot prints —
 * reaching past the snapshot's bound is the point of it — but prints far
 * less: a handful of matches, each with a short subtree.
 */
export const FIND_MAX_CHARS = 10_000;
export const FIND_MAX_MATCHES = 20;
export const FIND_MAX_QUERY_CHARS = 200;
const FIND_MAX_NODES = 20_000;
const FIND_MAX_SUBTREE_LINES = 20;

/**
 * Roles whose element a model can act on, and which therefore earn a ref.
 * Chromium spells ARIA-mapped roles in lower camel case; the comparison is
 * case-insensitive so an internal spelling drift downgrades a line to
 * unactionable rather than printing a wrong one.
 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

/**
 * Roles that are structure without information: their line would say nothing,
 * so their children are spliced up to where the reader already is.
 */
const SILENT_ROLES = new Set([
  "rootwebarea",
  "generic",
  "genericcontainer",
  "none",
  "presentation",
  "inlinetextbox",
  "linebreak",
]);

/** Chromium's text-leaf spelling, printed as the dialect's `text:` line. */
const TEXT_ROLES = new Set(["statictext", "text"]);

/**
 * The role as printed: Chromium spells every role in letters (and the odd
 * digit), and anything else is dropped so the one unquoted page-reported
 * word on a line can never carry a quote, a bracket or a colon.
 */
function roleOf(node: AXNodeLike): string {
  const value = node.role?.value;
  return typeof value === "string" ? value.replace(/[^A-Za-z0-9]/g, "") : "";
}

function nameOf(node: AXNodeLike): string {
  const value = node.name?.value;
  if (typeof value !== "string") return "";
  // A page's name is one line by decree: the printed shape is Volli's, and a
  // newline inside an accessible name must not mint a line the page wrote.
  // U+0085 (NEL) is a line break some readers honour that `\s` does not match.
  return value
    .slice(0, SNAPSHOT_MAX_NODE_NAME_CHARS)
    .replace(/[\s\u0085]+/g, " ")
    .trim();
}

function headingLevel(node: AXNodeLike): number | null {
  const property = node.properties?.find((candidate) => candidate.name === "level");
  const value = property?.value?.value;
  return typeof value === "number" ? value : null;
}

/**
 * One node worth a line, with silent structure already spliced away. The
 * tree of these is what both prints walk; nothing in it is text yet.
 */
interface Entry {
  /** The role as printed, or null for a text leaf. */
  role: string | null;
  name: string;
  level: number | null;
  /** The handle a ref resolves to — present only on elements that earn one. */
  backendDOMNodeId: number | null;
  children: Entry[];
}

interface Collection {
  roots: Entry[];
  truncated: boolean;
}

interface Traversal {
  visited: Set<string>;
  remainingNodes: number;
  truncated: boolean;
}

/**
 * Walk one node, appending what it contributes to `into`: its own entry, or —
 * for ignored and silent structure — its children, risen to the reader's
 * current depth exactly as the page reads to assistive tech.
 */
function collectNode(
  node: AXNodeLike,
  byId: ReadonlyMap<string, AXNodeLike>,
  treeDepth: number,
  parentName: string,
  into: Entry[],
  traversal: Traversal,
): void {
  if (
    traversal.visited.has(node.nodeId) ||
    traversal.remainingNodes === 0 ||
    treeDepth > SNAPSHOT_MAX_TREE_DEPTH
  ) {
    traversal.truncated = true;
    return;
  }
  traversal.visited.add(node.nodeId);
  traversal.remainingNodes -= 1;
  const printedRole = roleOf(node);
  const role = printedRole.toLowerCase();
  const children = (node.childIds ?? []).flatMap((childId) => byId.get(childId) ?? []);

  if (node.ignored === true || SILENT_ROLES.has(role) || role === "") {
    for (const child of children) {
      collectNode(child, byId, treeDepth + 1, parentName, into, traversal);
    }
    return;
  }

  const name = nameOf(node);
  if (TEXT_ROLES.has(role)) {
    // A text leaf that only repeats its parent's accessible name is the name
    // computation showing its work; the reader already has it.
    if (name === "" || name === parentName) return;
    into.push({ role: null, name, level: null, backendDOMNodeId: null, children: [] });
    return;
  }

  const entry: Entry = {
    role: printedRole,
    name,
    level: role === "heading" ? headingLevel(node) : null,
    backendDOMNodeId:
      INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId !== undefined
        ? node.backendDOMNodeId
        : null,
    children: [],
  };
  into.push(entry);
  for (const child of children) {
    collectNode(child, byId, treeDepth + 1, name, entry.children, traversal);
  }
}

/**
 * The tree worth printing. The roots are the nodes nothing points at — CDP
 * returns the tree flat, in document order, with `RootWebArea` first.
 */
function collect(nodes: readonly AXNodeLike[], maxNodes: number): Collection {
  const byId = new Map(nodes.map((candidate) => [candidate.nodeId, candidate]));
  const pointedAt = new Set(nodes.flatMap((candidate) => candidate.childIds ?? []));
  const traversal: Traversal = { visited: new Set(), remainingNodes: maxNodes, truncated: false };
  const roots: Entry[] = [];
  for (const root of nodes.filter((candidate) => !pointedAt.has(candidate.nodeId))) {
    collectNode(root, byId, 0, "", roots, traversal);
  }
  return { roots, truncated: traversal.truncated };
}

/**
 * One line to print: an entry at a depth, or — `entry: null` — Volli's `...`
 * for what a find left out there.
 */
interface PlannedLine {
  depth: number;
  entry: Entry | null;
  colon: boolean;
  match: boolean;
}

/**
 * A drafted line as printed. The colon is grammar, not content: it exists
 * exactly when lines print beneath this one — so a line whose children all
 * fell past the cut loses it.
 */
function lineText(line: { text: string; colon: boolean }): string {
  return line.colon ? `${line.text}:` : line.text;
}

const NO_LEDGER: RefLedger = { known: new Map(), nextRef: 1, markNew: false };

/** A ref as a line carries it, with Volli's `[new]` when the reader has not seen the element. */
function refMark(ref: string, isNew: boolean): string {
  return isNew ? ` [ref=${ref}] [new]` : ` [ref=${ref}]`;
}

/**
 * How many leading lines fit `maxChars`, newlines included. The cut falls on
 * a line boundary, and a first line longer than the whole bound fits none
 * rather than half of itself: a half line could show a quote with no end, or
 * a ref whose element the model cannot read.
 */
function linesWithin(lines: readonly { text: string; colon: boolean }[], maxChars: number): number {
  let length = -1;
  for (let index = 0; index < lines.length; index += 1) {
    length += lineText(lines[index]!).length + 1;
    if (length > maxChars) return index;
  }
  return lines.length;
}

/**
 * The first `kept` lines as text. A kept line with a colon has its first
 * child on the very next line; when that line is the first one cut, nothing
 * prints beneath it any more, so it loses the colon.
 */
function printKept(lines: readonly { text: string; colon: boolean }[], kept: number): string {
  return lines
    .slice(0, kept)
    .map((line, index) =>
      lineText(index === kept - 1 && kept < lines.length ? { ...line, colon: false } : line),
    )
    .join("\n");
}

/** One entry's line before any ref, mark or colon: its role, quoted name and level. */
function entryText(entry: Entry, indent: string): string {
  const text =
    entry.role === null
      ? `${indent}- text: ${JSON.stringify(entry.name)}`
      : `${indent}- ${entry.role}${entry.name === "" ? "" : ` ${JSON.stringify(entry.name)}`}`;
  return entry.level === null ? text : `${text} [level=${entry.level}]`;
}

/**
 * Turn planned lines into text under the bound, and decide which refs the
 * text shows. Refs come from the ledger when the generation knows the element
 * and are minted in document order when it does not; the bound falls on a
 * line boundary, and every ref is judged by the line that carries it.
 */
function render(
  plan: readonly PlannedLine[],
  ledger: RefLedger,
  maxChars: number,
  truncatedByWalk: boolean,
): Omit<BrowserSnapshotFormat, "empty"> & { keptLines: number } {
  interface Drafted {
    /** The line without its colon, which is decided only once the cut is known. */
    text: string;
    colon: boolean;
    ref: string | null;
    backendDOMNodeId: number | null;
    name: string;
    nextAfter: number;
  }
  const minted = new Map<number, string>();
  let next = ledger.nextRef;
  const drafted: Drafted[] = plan.map((line) => {
    const indent = "  ".repeat(line.depth);
    const entry = line.entry;
    if (entry === null) {
      return {
        text: `${indent}...`,
        colon: false,
        ref: null,
        backendDOMNodeId: null,
        name: "",
        nextAfter: next,
      };
    }
    let text = entryText(entry, indent);
    let ref: string | null = null;
    if (entry.backendDOMNodeId !== null) {
      const handle = entry.backendDOMNodeId;
      const remembered = ledger.known.get(handle) ?? minted.get(handle);
      if (remembered === undefined) {
        ref = `e${next}`;
        next += 1;
        minted.set(handle, ref);
        text += refMark(ref, ledger.markNew);
      } else {
        ref = remembered;
        text += refMark(ref, false);
      }
    }
    if (line.match) text += " [match]";
    return {
      text,
      colon: line.colon,
      ref,
      backendDOMNodeId: entry.backendDOMNodeId,
      name: entry.name,
      nextAfter: next,
    };
  });

  const kept = linesWithin(drafted, maxChars);
  const shown = drafted.slice(0, kept);

  // Refs the cut text no longer shows must not stay actionable: a model acting
  // on a ref it cannot see is acting on a page it was not shown. Judged by the
  // line that carries each ref, never by re-reading tokens out of the text — a
  // page's own name can carry a `[ref=eN]` lookalike, and a token inside
  // quotes is the page talking, not a key of this map.
  const refs = new Map<string, number>();
  const names = new Map<string, string>();
  for (const line of shown) {
    if (line.ref === null || line.backendDOMNodeId === null) continue;
    refs.set(line.ref, line.backendDOMNodeId);
    if (line.name !== "" && !names.has(line.ref)) names.set(line.ref, line.name);
  }
  return {
    text: printKept(drafted, kept),
    refs,
    names,
    nextRef: kept === 0 ? ledger.nextRef : shown[kept - 1]!.nextAfter,
    truncated: truncatedByWalk || kept < drafted.length,
    keptLines: kept,
  };
}

function planAll(entries: readonly Entry[], depth: number, into: PlannedLine[]): void {
  for (const entry of entries) {
    into.push({ depth, entry, colon: entry.children.length > 0, match: false });
    planAll(entry.children, depth + 1, into);
  }
}

/**
 * The most characters a whole print writes (VC-237). A bound on what one read
 * may hold in memory rather than on what a reader is shown: the runtime saves
 * the print, and one saved file holds no more than this anyway.
 */
const SNAPSHOT_WHOLE_MAX_CHARS = 8 * 1_024 * 1_024;

/**
 * The tree past the bound that cut a snapshot, for the runtime to save
 * (VC-237), or undefined when the cut print already showed all of it.
 *
 * It walks as far as a find does, since reaching past the snapshot's bound is
 * the point, and prints in the same dialect with one difference: only an
 * element the cut print SHOWED carries its ref (and its `[new]`), exactly as
 * that print carried it. An element past the cut was never shown, so it gets
 * no ref — a number minted for it here would be one the ledger never
 * remembered, and could name a different element on the next read.
 */
function printWhole(
  nodes: readonly AXNodeLike[],
  collected: Collection,
  shown: { refs: ReadonlyMap<string, number>; keptLines: number },
  ledger: RefLedger,
): RuntimeWholeText | undefined {
  const walked = collected.truncated ? collect(nodes, FIND_MAX_NODES) : collected;
  const plan: PlannedLine[] = [];
  planAll(walked.roots, 0, plan);
  if (plan.length <= shown.keptLines) return undefined;
  const refOf = new Map([...shown.refs].map(([ref, handle]) => [handle, ref]));
  const lines: { text: string; colon: boolean }[] = [];
  let length = -1;
  for (const line of plan) {
    // `planAll` plans every entry and no `...` line.
    const entry = line.entry!;
    let text = entryText(entry, "  ".repeat(line.depth));
    const handle = entry.backendDOMNodeId;
    const ref = handle === null ? undefined : refOf.get(handle);
    // New exactly when the cut print marked it so: shown, and not in the ledger.
    if (ref !== undefined) text += refMark(ref, ledger.markNew && !ledger.known.has(handle!));
    const drafted = { text, colon: line.colon };
    lines.push(drafted);
    // Drafting stops at the first line past the bound, so memory stays near
    // it; `linesWithin` then cuts there, exactly as for the cut print.
    length += lineText(drafted).length + 1;
    if (length > SNAPSHOT_WHOLE_MAX_CHARS) break;
  }
  const kept = linesWithin(lines, SNAPSHOT_WHOLE_MAX_CHARS);
  return { text: printKept(lines, kept), bounded: walked.truncated || kept < lines.length };
}

/**
 * Print a full CDP accessibility tree in the snapshot dialect, bounded, with
 * refs drawn from the generation's ledger — and, when the bound cut it, the
 * tree printed whole beside it ({@link printWhole}).
 */
export function formatAXSnapshot(
  nodes: readonly AXNodeLike[],
  limits: { maxChars?: number; ledger?: RefLedger } = {},
): BrowserSnapshotFormat & { whole?: RuntimeWholeText } {
  const collected = collect(nodes, SNAPSHOT_MAX_NODES);
  const plan: PlannedLine[] = [];
  planAll(collected.roots, 0, plan);
  const ledger = limits.ledger ?? NO_LEDGER;
  const { keptLines, ...printed } = render(
    plan,
    ledger,
    limits.maxChars ?? SNAPSHOT_MAX_CHARS,
    collected.truncated,
  );
  const whole = printed.truncated
    ? printWhole(nodes, collected, { refs: printed.refs, keptLines }, ledger)
    : undefined;
  // Empty is the page's fact, judged before the bound: a tree the cut left
  // no room to print is truncated, not empty — and so is one whose walk hit
  // its node or depth bound before reaching anything worth a line (a hidden
  // sprite sheet ahead of the content can spend the whole node budget).
  return {
    ...printed,
    empty: collected.roots.length === 0 && !collected.truncated,
    ...(whole === undefined ? {} : { whole }),
  };
}

/**
 * The AX states the digest compares: what an action visibly flips. Focus is
 * deliberately absent — every click moves it, and a digest that saw it would
 * report every action as a change.
 */
const DIGEST_STATES = new Set(["checked", "expanded", "selected", "pressed", "disabled"]);

/**
 * How many nodes the digest walks. It runs on every read in the host's main
 * process, so it shares the find's walk bound rather than growing with the
 * page: about 7ms for 20,000 nodes on an M-series Mac, against ~30ms for an
 * unbounded 100,000. A change past the bound goes unseen — well past anything
 * a snapshot prints.
 */
const DIGEST_MAX_NODES = FIND_MAX_NODES;

/**
 * A fingerprint of everything the tree exposes that an action could visibly
 * change (VC-277): each unignored node's role, name, value, child count and
 * the states above, in CDP's document order. Two reads of an unchanged page
 * give the same digest whatever either read printed, so it is independent of
 * the print bounds and the ledger; it is compared, never shown.
 */
export function axTreeDigest(nodes: readonly AXNodeLike[]): string {
  const hash = createHash("sha256");
  for (const node of nodes.slice(0, DIGEST_MAX_NODES)) {
    if (node.ignored === true) continue;
    const states = (node.properties ?? [])
      .filter((property) => DIGEST_STATES.has(property.name))
      .map((property) => [property.name, property.value?.value ?? null]);
    hash.update(
      JSON.stringify([
        node.role?.value ?? null,
        node.name?.value ?? null,
        node.value?.value ?? null,
        node.childIds?.length ?? 0,
        states,
      ]),
    );
    hash.update("\n");
  }
  return hash.digest("hex");
}

/**
 * A find query as the search compares it — whitespace collapsed, lower-cased —
 * or null when there is nothing to search for or more than the bound allows.
 * Literal by construction: nothing here is a pattern.
 */
export function normalizeFindQuery(query: string): string | null {
  const normalized = query.replace(/\s+/g, " ").trim();
  if (normalized === "" || normalized.length > FIND_MAX_QUERY_CHARS) return null;
  return normalized.toLowerCase();
}

/**
 * Search the whole tree for a literal, case-insensitive substring of an
 * accessible name or a text leaf, and print only what answers it: each match
 * under its path from the root, its subtree to a short bound, and a `...`
 * line wherever something was left out.
 *
 * `needle` is expected already normalized ({@link normalizeFindQuery}); the
 * refs follow the same ledger and the same cut as a snapshot, so a find's
 * refs are as usable — and as strictly judged — as a snapshot's.
 */
export function formatAXFind(
  nodes: readonly AXNodeLike[],
  needle: string,
  limits: { maxChars?: number; ledger?: RefLedger } = {},
): BrowserFindFormat {
  const collected = collect(nodes, FIND_MAX_NODES);
  const query = needle.toLowerCase();
  const parents = new Map<Entry, Entry | null>();
  const order: Entry[] = [];
  const walk = (entries: readonly Entry[], parent: Entry | null): void => {
    for (const entry of entries) {
      parents.set(entry, parent);
      order.push(entry);
      walk(entry.children, entry);
    }
  };
  walk(collected.roots, null);

  const matched = new Set(
    order.filter((entry) => entry.name !== "" && entry.name.toLowerCase().includes(query)),
  );
  const included = new Set<Entry>();
  let chosen = 0;
  for (const entry of order) {
    if (!matched.has(entry) || included.has(entry)) continue;
    if (chosen === FIND_MAX_MATCHES) break;
    chosen += 1;
    // The path from the root is the context that says where the match is.
    for (let up = parents.get(entry) ?? null; up !== null; up = parents.get(up) ?? null) {
      included.add(up);
    }
    included.add(entry);
    // And its own subtree, in document order, to the bound.
    let budget = FIND_MAX_SUBTREE_LINES;
    const descend = (entries: readonly Entry[]): void => {
      for (const child of entries) {
        if (budget === 0) return;
        budget -= 1;
        included.add(child);
        descend(child.children);
      }
    };
    descend(entry.children);
  }

  const plan: PlannedLine[] = [];
  const planIncluded = (entries: readonly Entry[], depth: number): void => {
    let gap = false;
    for (const entry of entries) {
      if (!included.has(entry)) {
        gap = true;
        continue;
      }
      if (gap) plan.push({ depth, entry: null, colon: false, match: false });
      gap = false;
      const line: PlannedLine = { depth, entry, colon: false, match: matched.has(entry) };
      plan.push(line);
      const before = plan.length;
      planIncluded(entry.children, depth + 1);
      line.colon = plan.length > before;
    }
    if (gap) plan.push({ depth, entry: null, colon: false, match: false });
  };
  if (chosen > 0) planIncluded(collected.roots, 0);

  const { keptLines, ...printed } = render(
    plan,
    limits.ledger ?? NO_LEDGER,
    limits.maxChars ?? FIND_MAX_CHARS,
    collected.truncated,
  );
  // Counted off the lines the bound kept, so Volli never claims to show a
  // match the cut removed.
  const shown = plan.slice(0, keptLines).filter((line) => line.match).length;
  return {
    ...printed,
    matches: matched.size,
    shown,
    empty: order.length === 0 && !collected.truncated,
  };
}
