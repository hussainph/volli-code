// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { FileTree } from "./file-tree";
import type { FileNavigatorControls } from "./use-navigator-mutations";
import { buildTree, flattenTree, fuzzyIndices } from "./file-tree-model";

describe("file tree model", () => {
  it("compacts folder chains, sorts folders first and keeps full path identity", () => {
    const tree = buildTree([{ path: "z.md" }, { path: "apps/desktop/editor.ts" }]);
    expect(tree[0]).toMatchObject({ path: "apps/desktop", label: "apps/desktop" });
    expect(tree[1]?.file?.path).toBe("z.md");
  });
  it("retains host-confirmed empty directories without duplicating indexed ancestry", () => {
    const tree = buildTree([
      { path: "empty", directory: true },
      { path: "src", directory: true },
      { path: "src/tree.ts" },
    ]);
    expect(tree.map((node) => node.path)).toEqual(["empty", "src"]);
    expect(flattenTree(tree, new Set()).map((row) => row.node.path)).toEqual(["empty", "src"]);
    expect(flattenTree(tree, new Set(), "empty").map((row) => row.node.path)).toEqual(["empty"]);
  });
  it("filters matching ancestry without changing saved folds", () => {
    const folds = new Set<string>();
    const rows = flattenTree(
      buildTree([{ path: "src/files/tree.tsx" }, { path: "src/files/other.ts" }]),
      folds,
      "treetsx",
    );
    expect(rows.map((row) => row.node.path)).toEqual(["src/files", "src/files/tree.tsx"]);
    expect(rows[0]?.expanded).toBe(true);
    expect(rows[1]).toMatchObject({ depth: 1, parent: "src/files", position: 1, siblings: 1 });
    expect(folds.size).toBe(0);
    expect(fuzzyIndices("FileTree.tsx", "f t x")).toEqual([0, 4, 11]);
  });
});

describe("virtual file tree", () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { files: { listExternalApps: async () => ({ ok: true, apps: [] }) } },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "api");
  });
  async function key(pressed: string, metaKey = false) {
    await act(async () => {
      container
        .querySelector('[role="tree"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: pressed, metaKey, bubbles: true }));
    });
  }
  it("illustrates a genuinely empty tree, never a filter with no matches", async () => {
    const open = vi.fn();
    const pin = vi.fn();
    for (const query of ["", "missing"]) {
      await act(async () =>
        root.render(
          <TooltipProvider>
            <FileTree projectId="p" entries={[]} query={query} onOpen={open} onPin={pin} />
          </TooltipProvider>,
        ),
      );
      expect(container.querySelector('[data-next-action="files"]') !== null).toBe(!query);
      expect(container.textContent).toContain(query ? "No matches" : "No files");
      expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
    }
    expect(open).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
  });
  it("bounds 12,000 expanded files and keeps the active descendant mounted", async () => {
    const open = vi.fn();
    const pin = vi.fn();
    await act(async () =>
      root.render(
        <TooltipProvider>
          <FileTree
            projectId="p"
            entries={Array.from({ length: 12000 }, (_, i) => ({
              path: `src/file-${String(i).padStart(5, "0")}.ts`,
            }))}
            onOpen={open}
            onPin={pin}
          />
        </TooltipProvider>,
      ),
    );
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    await key("ArrowRight");
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeLessThan(40);
    await key("End");
    await key("Enter");
    expect(open).toHaveBeenLastCalledWith("src/file-11999.ts");
    await key("Enter", true);
    expect(pin).toHaveBeenLastCalledWith("src/file-11999.ts");
    const tree = container.querySelector('[role="tree"]')!;
    expect(document.getElementById(tree.getAttribute("aria-activedescendant")!)).not.toBeNull();
  });
  it("bounds content matches and reaches an offscreen hit with the same keyboard cursor", async () => {
    const openMatch = vi.fn();
    await act(async () =>
      root.render(
        <TooltipProvider>
          <FileTree
            projectId="p"
            entries={[
              {
                path: "src/tree.tsx",
                matches: Array.from({ length: 1000 }, (_, index) => ({
                  line: index + 1,
                  text: "match",
                })),
              },
            ]}
            onOpen={() => {}}
            onPin={() => {}}
            searchMatches={{ render: (match) => <span>{match.line}</span>, onOpen: openMatch }}
          />
        </TooltipProvider>,
      ),
    );
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeLessThan(40);
    await key("ArrowRight");
    await key("ArrowRight");
    await key("Enter");
    expect(openMatch).toHaveBeenCalledWith("src/tree.tsx", 1);
    await key("End");
    await key("Enter");
    expect(openMatch).toHaveBeenCalledWith("src/tree.tsx", 1000);
    const tree = container.querySelector('[role="tree"]')!;
    const active = document.getElementById(tree.getAttribute("aria-activedescendant")!);
    expect(active?.getAttribute("data-line")).toBe("1000");
    expect(active?.getAttribute("title")).toBe("match");
  });
  it("opens files on click, pins on double click, and folds with Left", async () => {
    const open = vi.fn();
    const pin = vi.fn();
    const folder = vi.fn();
    await act(async () =>
      root.render(
        <TooltipProvider>
          <FileTree
            projectId="p"
            entries={[{ path: "src/tree.tsx" }]}
            onOpen={open}
            onPin={pin}
            onFolder={folder}
          />
        </TooltipProvider>,
      ),
    );
    await key("ArrowRight");
    const file = container.querySelector('[data-path="src/tree.tsx"]')!;
    await act(async () => {
      file.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      file.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(open).toHaveBeenCalledWith("src/tree.tsx");
    expect(pin).toHaveBeenCalledWith("src/tree.tsx");
    await key("ArrowLeft");
    await key("ArrowLeft");
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    expect(folder).toHaveBeenLastCalledWith("");
  });
  it("names a referenced row as referenced, not only with its paperclip", async () => {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <FileTree
            projectId="p"
            entries={[{ path: "keep.ts", referenced: true }, { path: "plain.ts" }]}
            onOpen={vi.fn()}
            onPin={vi.fn()}
          />
        </TooltipProvider>,
      ),
    );
    const referenced = container.querySelector('[data-path="keep.ts"]')!;
    expect(referenced.getAttribute("aria-label")).toBe("keep.ts, referenced");
    expect(referenced.getAttribute("title")).toBe("Referenced · keep.ts");
    const plain = container.querySelector('[data-path="plain.ts"]')!;
    expect(plain.getAttribute("aria-label")).toBe("plain.ts");
    expect(plain.getAttribute("title")).toBe("plain.ts");
  });
  it("keeps the inline rename inert and the empty tree's draft reachable", async () => {
    const open = vi.fn();
    const controls: FileNavigatorControls = {
      edit: { kind: "rename", relPath: "src/tree.tsx" },
      canWrite: true,
      startDraft: vi.fn(),
      startRename: vi.fn(),
      cancelEdit: vi.fn(),
      commitDraft: vi.fn(),
      commitRename: vi.fn(),
      duplicate: vi.fn(),
      remove: vi.fn(),
    };
    await act(async () =>
      root.render(
        <TooltipProvider>
          <FileTree
            projectId="p"
            entries={[{ path: "src/tree.tsx" }]}
            initialFolder="src"
            controls={controls}
            onOpen={open}
            onPin={() => {}}
          />
        </TooltipProvider>,
      ),
    );
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Rename tree.tsx"]');
    expect(input).not.toBeNull();
    await act(async () => input!.click());
    expect(open).not.toHaveBeenCalled();
    controls.edit = { kind: "draft", entry: "directory" };
    await act(async () =>
      root.render(
        <TooltipProvider>
          <FileTree projectId="p" entries={[]} controls={controls} onOpen={open} onPin={() => {}} />
        </TooltipProvider>,
      ),
    );
    expect(container.querySelector('input[aria-label="New folder name"]')).not.toBeNull();
  });
  it("offers sentence-case creation actions in the file context menu", async () => {
    const controls: FileNavigatorControls = {
      edit: { kind: "none" },
      canWrite: true,
      startDraft: vi.fn(),
      startRename: vi.fn(),
      cancelEdit: vi.fn(),
      commitDraft: vi.fn(),
      commitRename: vi.fn(),
      duplicate: vi.fn(),
      remove: vi.fn(),
    };
    await act(async () =>
      root.render(
        <TooltipProvider>
          <FileTree
            projectId="p"
            entries={[{ path: "file.ts" }]}
            controls={controls}
            onOpen={() => {}}
            onPin={() => {}}
          />
        </TooltipProvider>,
      ),
    );
    await key("ContextMenu");
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toContain("New folder…");
    const create = items.find((item) => item.textContent === "New file…");
    expect(create).toBeDefined();
    await act(async () => create!.click());
    expect(controls.startDraft).toHaveBeenCalledWith("file");
  });
  it("targets the keyboard-opened file's parent and the context-clicked folder for creation", async () => {
    const folder = vi.fn();
    await act(async () =>
      root.render(
        <TooltipProvider>
          <FileTree
            projectId="p"
            entries={[{ path: "src/tree.tsx" }, { path: "docs/guide.md" }]}
            onOpen={() => {}}
            onPin={() => {}}
            onFolder={folder}
          />
        </TooltipProvider>,
      ),
    );
    await key("End");
    await key("ArrowRight");
    await key("ArrowDown");
    await key("Enter");
    expect(folder).toHaveBeenLastCalledWith("src");
    await act(async () =>
      container
        .querySelector('[data-path="docs"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
    );
    expect(folder).toHaveBeenLastCalledWith("docs");
  });
});
