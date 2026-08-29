/**
 * The accessibility-snapshot printer: CDP's `Accessibility.getFullAXTree`
 * answer in, the ref-bearing text a model reads out.
 *
 * The dialect is Playwright MCP's — `- role "name" [ref=eN]` lines, children
 * indented under a trailing colon — adopted as a format spec rather than
 * vendored code (see docs/research/browser-tooling-vc-110.md and the VC-110
 * decision comment). The hard half of a snapshot, computing roles and
 * accessible names, is not done here at all: Chromium already resolved both
 * before the tree crossed the debugger, so this module only decides what is
 * worth a line, what earns a ref, and where the bound falls.
 *
 * Refs are the interaction contract. `eN` numbers are minted in document
 * order per print, and the map they resolve through — ref to
 * `backendDOMNodeId` — is returned beside the text so the controller can
 * dispatch real input at the element the model named. A ref is meaningful
 * only against the print that minted it; generation bookkeeping lives with
 * the controller, which is the party that knows when a page changed.
 *
 * Everything printed here is page-derived and therefore untrusted. The
 * envelope that says so belongs to the runtime's browser tools; this module's
 * obligation is only to keep the shape Volli's — one node per line, names
 * quoted, no line a page's text can fake its way out of (newlines in names
 * are collapsed before printing).
 */

/** A CDP AXNode, cut to the fields this printer reads. */
export interface AXNodeLike {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/** One printed snapshot: the text, the handles its refs resolve to, and the bound's verdict. */
export interface BrowserSnapshotFormat {
  text: string;
  /** `eN` to the CDP backendDOMNodeId input is dispatched at. */
  refs: ReadonlyMap<string, number>;
  truncated: boolean;
}

/**
 * The default character bound. Snapshots exist to be cheaper than screenshots;
 * an unbounded print of a pathological page would spend the budget the format
 * was chosen to save.
 */
export const SNAPSHOT_MAX_CHARS = 30_000;

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

function roleOf(node: AXNodeLike): string {
  const value = node.role?.value;
  return typeof value === "string" ? value : "";
}

function nameOf(node: AXNodeLike): string {
  const value = node.name?.value;
  if (typeof value !== "string") return "";
  // A page's name is one line by decree: the printed shape is Volli's, and a
  // newline inside an accessible name must not mint a line the page wrote.
  return value.replace(/\s+/g, " ").trim();
}

function headingLevel(node: AXNodeLike): number | null {
  const property = node.properties?.find((candidate) => candidate.name === "level");
  const value = property?.value?.value;
  return typeof value === "number" ? value : null;
}

/**
 * Print one node and its subtree, appending lines and minting refs in
 * document order. Returns the lines it contributed so a parent can decide
 * whether it earned a trailing colon.
 */
/** One minted ref and the line that minted it — the fact truncation judges by. */
interface MintedRef {
  ref: string;
  backendDOMNodeId: number;
  lineIndex: number;
}

function printNode(
  node: AXNodeLike,
  byId: ReadonlyMap<string, AXNodeLike>,
  depth: number,
  parentName: string,
  lines: string[],
  refs: MintedRef[],
): void {
  const role = roleOf(node).toLowerCase();
  const children = (node.childIds ?? []).flatMap((childId) => byId.get(childId) ?? []);

  // Ignored nodes and silent structure vanish; their children rise to the
  // reader's current depth, exactly as the page reads to assistive tech.
  if (node.ignored === true || SILENT_ROLES.has(role) || role === "") {
    for (const child of children) printNode(child, byId, depth, parentName, lines, refs);
    return;
  }

  const name = nameOf(node);
  const indent = "  ".repeat(depth);

  if (TEXT_ROLES.has(role)) {
    // A text leaf that only repeats its parent's accessible name is the name
    // computation showing its work; the reader already has it.
    if (name === "" || name === parentName) return;
    lines.push(`${indent}- text: ${name}`);
    return;
  }

  let line = `${indent}- ${roleOf(node)}`;
  if (name !== "") line += ` ${JSON.stringify(name)}`;
  const level = role === "heading" ? headingLevel(node) : null;
  if (level !== null) line += ` [level=${level}]`;
  if (INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId !== undefined) {
    const ref = `e${refs.length + 1}`;
    refs.push({ ref, backendDOMNodeId: node.backendDOMNodeId, lineIndex: lines.length });
    line += ` [ref=${ref}]`;
  }

  const index = lines.push(line) - 1;
  for (const child of children) printNode(child, byId, depth + 1, name, lines, refs);
  // The colon is grammar, not content: it exists exactly when children
  // actually printed beneath this line.
  if (lines.length > index + 1) lines[index] = `${line}:`;
}

/**
 * Print a full CDP accessibility tree in the snapshot dialect.
 *
 * The root is the node nothing points at — CDP returns the tree flat, in
 * document order, with `RootWebArea` first — and the bound falls on a line
 * boundary so a cut snapshot is still parseable, with `truncated` carrying
 * what the text no longer can.
 */
export function formatAXSnapshot(
  nodes: readonly AXNodeLike[],
  limits: { maxChars?: number } = {},
): BrowserSnapshotFormat {
  const maxChars = limits.maxChars ?? SNAPSHOT_MAX_CHARS;
  const byId = new Map(nodes.map((candidate) => [candidate.nodeId, candidate]));
  const pointedAt = new Set(nodes.flatMap((candidate) => candidate.childIds ?? []));
  const roots = nodes.filter((candidate) => !pointedAt.has(candidate.nodeId));

  const lines: string[] = [];
  const minted: MintedRef[] = [];
  for (const root of roots) printNode(root, byId, 0, "", lines, minted);

  let keptLines = lines.length;
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > maxChars) {
    const cut = text.lastIndexOf("\n", maxChars);
    text = text.slice(0, cut === -1 ? maxChars : cut);
    truncated = true;
    keptLines = text === "" ? 0 : text.split("\n").length;
  }

  // Refs the cut text no longer shows must not stay actionable: a model acting
  // on a ref it cannot see is acting on a page it was not shown. Judged by the
  // line that MINTED each ref, never by re-reading tokens out of the surviving
  // text — a page's own name can carry a `[ref=eN]` lookalike, and a token
  // inside quotes is the page talking, not a key of this map.
  const refs = new Map(
    minted.filter((one) => one.lineIndex < keptLines).map((one) => [one.ref, one.backendDOMNodeId]),
  );

  return { text, refs, truncated };
}
