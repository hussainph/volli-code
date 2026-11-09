export type GitStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
export interface FileEntry {
  path: string;
  directory?: boolean;
  status?: GitStatus;
  previousPath?: string;
  insertions?: number | null;
  deletions?: number | null;
  binary?: boolean;
  updated?: boolean;
  referenced?: boolean;
  matches?: readonly { line: number; text: string }[];
}
export interface TreeNode {
  path: string;
  label: string;
  children: TreeNode[];
  file?: FileEntry;
  changed: number;
}
export interface TreeRow {
  node: TreeNode;
  depth: number;
  parent: string | null;
  expanded: boolean;
  position: number;
  siblings: number;
  match?: { line: number; text: string };
}

/** Subsequence path matching; callers reuse the indices to paint the exact match. */
export function fuzzyIndices(text: string, query: string): number[] | null {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const haystack = text.toLowerCase();
  const indices: number[] = [];
  let from = 0;
  for (const letter of needle) {
    const at = haystack.indexOf(letter, from);
    if (at < 0) return null;
    indices.push(at);
    from = at + 1;
  }
  return indices;
}

/** Build a compact, folder-first tree from the scoped host index. */
export function buildTree(entries: readonly FileEntry[], compact = true): TreeNode[] {
  const root: TreeNode = { path: "", label: "", children: [], changed: 0 };
  const folders = new Map<string, TreeNode>([["", root]]);
  for (const file of entries) {
    const parts = file.path.split("/");
    let parent = root;
    for (let i = 0; i < parts.length - (file.directory ? 0 : 1); i++) {
      const path = parts.slice(0, i + 1).join("/");
      let folder = folders.get(path);
      if (!folder) {
        folder = { path, label: parts[i]!, children: [], changed: 0 };
        folders.set(path, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
    if (file.directory) continue;
    parent.children.push({
      path: file.path,
      label: parts.at(-1)!,
      children: [],
      file,
      changed: file.status ? 1 : 0,
    });
  }
  function finish(node: TreeNode): TreeNode {
    node.children = node.children
      .map(finish)
      .toSorted(
        (a, b) =>
          Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.label.localeCompare(b.label),
      );
    if (!node.file) node.changed = node.children.reduce((count, child) => count + child.changed, 0);
    if (
      compact &&
      node.path &&
      !node.file &&
      node.children.length === 1 &&
      !node.children[0]!.file
    ) {
      const child = node.children[0]!;
      return { ...child, label: `${node.label}/${child.label}` };
    }
    return node;
  }
  return finish(root).children;
}

/** Filter first, then flatten. A query expands only its matching ancestry, not saved folds. */
export function flattenTree(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  query = "",
  changedOnly = false,
  contentQuery = "",
  showMatches = false,
): TreeRow[] {
  function filter(node: TreeNode): TreeNode | null {
    if (node.file) {
      if (changedOnly && !node.file.status) return null;
      if (query && fuzzyIndices(node.path, query) === null) return null;
      if (
        contentQuery &&
        !node.file.matches?.some((match) =>
          match.text.toLowerCase().includes(contentQuery.toLowerCase()),
        )
      )
        return null;
      return node;
    }
    const children = node.children.map(filter).filter((child): child is TreeNode => child !== null);
    if (
      node.children.length === 0 &&
      !changedOnly &&
      !contentQuery &&
      (!query || fuzzyIndices(node.path, query) !== null)
    )
      return node;
    return children.length ? { ...node, children } : null;
  }
  const filtered = nodes.map(filter).filter((node): node is TreeNode => node !== null);
  const rows: TreeRow[] = [];
  function walk(children: readonly TreeNode[], depth: number, parent: string | null) {
    children.forEach((node, index) => {
      const open =
        !node.file && (Boolean(query || contentQuery || showMatches) || expanded.has(node.path));
      rows.push({
        node,
        depth,
        parent,
        expanded: open,
        position: index + 1,
        siblings: children.length,
      });
      if (open) walk(node.children, depth + 1, node.path);
      if (showMatches && node.file?.matches) {
        node.file.matches.forEach((match, matchIndex, matches) => {
          rows.push({
            node,
            match,
            depth: depth + 1,
            parent: node.path,
            expanded: false,
            position: matchIndex + 1,
            siblings: matches.length,
          });
        });
      }
    });
  }
  walk(filtered, 0, null);
  return rows;
}
