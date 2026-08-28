/**
 * The navigator controller's behaviour (VC-191) — the half of the feature that
 * is a decision rather than a drawing: which verb a commit reaches for, what the
 * host is told afterwards, and the one refusal the renderer makes on its own.
 */
// The desktop owns jsdom for renderer tests, but does not ship its ambient types.
// @ts-expect-error — this test only uses the typed-at-runtime JSDOM constructor.
import { JSDOM } from "jsdom";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FileMutationResult, Result } from "../../../../ipc/contract";
import {
  useFileNavigatorMutations,
  type FileNavigatorControls,
  type FileNavigatorScope,
} from "./use-navigator-mutations";

const { peek, toastError } = vi.hoisted(() => ({ peek: vi.fn(), toastError: vi.fn() }));

vi.mock("@renderer/editor/monaco-runtime", () => ({
  loadMonacoRuntime: async () => ({ registry: { peek } }),
}));
vi.mock("@renderer/lib/toast", () => ({ toastError }));

let root: Root | null = null;

function api() {
  return {
    create: vi.fn(
      async (input: { relPath: string }): Promise<FileMutationResult> => ({
        ok: true,
        relPath: input.relPath,
      }),
    ),
    createDirectory: vi.fn(
      async (input: { relPath: string }): Promise<FileMutationResult> => ({
        ok: true,
        relPath: input.relPath,
      }),
    ),
    rename: vi.fn(
      async (input: { toRelPath: string }): Promise<FileMutationResult> => ({
        ok: true,
        relPath: input.toRelPath,
      }),
    ),
    duplicate: vi.fn(
      async (): Promise<FileMutationResult> => ({ ok: true, relPath: "src/row copy.tsx" }),
    ),
    delete: vi.fn(async (): Promise<Result> => ({ ok: true })),
  };
}

const host = { refresh: vi.fn(), openCreated: vi.fn(), renameTab: vi.fn() };

/** Mounts the hook and hands back its live controls, plus the stubbed IPC surface. */
async function mount(scope: FileNavigatorScope, cwd: string) {
  const dom: { window: Window & typeof globalThis } = new JSDOM("<div id=app></div>");
  const files = api();
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("navigator", dom.window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(dom.window, "api", { configurable: true, value: { files } });

  let controls: FileNavigatorControls | null = null;
  function Probe() {
    controls = useFileNavigatorMutations({ scope, cwd, host });
    return null;
  }
  const container = dom.window.document.querySelector("#app");
  if (container === null) throw new Error("missing test container");
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
  const read = (): FileNavigatorControls => {
    if (controls === null) throw new Error("the probe never rendered");
    return controls;
  };
  return { read, files };
}

beforeEach(() => {
  peek.mockReset();
  peek.mockReturnValue(null);
  toastError.mockReset();
  host.refresh.mockReset();
  host.openCreated.mockReset();
  host.renameTab.mockReset();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
});

describe("creating", () => {
  it("creates in the folder on screen and opens the file pinned", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    await act(async () => read().startDraft("file"));
    expect(read().edit).toEqual({ kind: "draft", entry: "file" });

    await act(async () => read().commitDraft("row.tsx"));

    expect(files.create).toHaveBeenCalledWith({ projectId: "p1", relPath: "src/row.tsx" });
    expect(host.openCreated).toHaveBeenCalledWith("src/row.tsx");
    expect(host.refresh).toHaveBeenCalled();
    // The field closes on commit rather than waiting for the round trip.
    expect(read().edit).toEqual({ kind: "none" });
  });

  it("creates a FOLDER with the directory verb, and opens nothing", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "");
    await act(async () => read().startDraft("directory"));
    await act(async () => read().commitDraft("components"));

    expect(files.createDirectory).toHaveBeenCalledWith({ projectId: "p1", relPath: "components" });
    expect(files.create).not.toHaveBeenCalled();
    expect(host.openCreated).not.toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalled();
  });

  it("carries the ticket scope, so a Ticket navigator writes into its worktree", async () => {
    const { read, files } = await mount({ projectId: "p1", ticketId: "t1" }, "src");
    await act(async () => read().startDraft("file"));
    await act(async () => read().commitDraft("row.tsx"));

    expect(files.create).toHaveBeenCalledWith({
      projectId: "p1",
      ticketId: "t1",
      relPath: "src/row.tsx",
    });
  });

  it("says why a name was refused, without asking main about it", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    await act(async () => read().startDraft("file"));
    await act(async () => read().commitDraft("../escape.ts"));

    expect(files.create).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('"../escape.ts" cannot be used as a name');
  });

  it("surfaces main's refusal instead of pretending the file appeared", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    files.create.mockResolvedValueOnce({ ok: false, error: '"row.tsx" already exists' });
    await act(async () => read().startDraft("file"));
    await act(async () => read().commitDraft("row.tsx"));

    expect(toastError).toHaveBeenCalledWith(`Couldn't create row.tsx: "row.tsx" already exists`);
    expect(host.openCreated).not.toHaveBeenCalled();
    expect(host.refresh).not.toHaveBeenCalled();
  });
});

describe("renaming", () => {
  it("renames, then tells the host to move the tab across", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    await act(async () => read().startRename("src/row.tsx"));
    expect(read().edit).toEqual({ kind: "rename", relPath: "src/row.tsx" });

    await act(async () => read().commitRename("src/row.tsx", "list-row.tsx"));

    expect(files.rename).toHaveBeenCalledWith({
      projectId: "p1",
      relPath: "src/row.tsx",
      toRelPath: "src/list-row.tsx",
    });
    expect(host.renameTab).toHaveBeenCalledWith("src/row.tsx", "src/list-row.tsx");
    expect(host.refresh).toHaveBeenCalled();
  });

  it("refuses a file with unsaved changes, and says how to get past it", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    peek.mockReturnValue({ snapshot: () => ({ dirty: true }) });

    await act(async () => read().commitRename("src/row.tsx", "list-row.tsx"));

    expect(files.rename).not.toHaveBeenCalled();
    expect(host.renameTab).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      "Save row.tsx before renaming it — it has unsaved changes.",
    );
  });

  it("checks the MAIN document too inside a ticket, where `.volli/**` still lives", async () => {
    const { read, files } = await mount({ projectId: "p1", ticketId: "t1" }, "");
    // Only the main-checkout identity is dirty — the case a worktree-only check
    // would rename out from under.
    peek.mockImplementation((identity: { checkout?: { kind: string } }) =>
      identity.checkout?.kind === "main" ? { snapshot: () => ({ dirty: true }) } : null,
    );

    await act(async () => read().commitRename(".volli/artifacts/plan.md", "notes.md"));

    expect(files.rename).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      "Save plan.md before renaming it — it has unsaved changes.",
    );
  });

  it("refuses a new name that would move the file, before any IPC", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    await act(async () => read().commitRename("src/row.tsx", "elsewhere/row.tsx"));

    expect(files.rename).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("A new name cannot contain a slash");
  });

  it("leaves the tab where it is when main refuses the rename", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    files.rename.mockResolvedValueOnce({ ok: false, error: '"list-row.tsx" already exists' });

    await act(async () => read().commitRename("src/row.tsx", "list-row.tsx"));

    expect(host.renameTab).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      `Couldn't rename list-row.tsx: "list-row.tsx" already exists`,
    );
  });
});

describe("duplicating and deleting", () => {
  it("duplicates without stealing the editor away from the original", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    await act(async () => read().duplicate("src/row.tsx"));

    expect(files.duplicate).toHaveBeenCalledWith({ projectId: "p1", relPath: "src/row.tsx" });
    expect(host.refresh).toHaveBeenCalled();
    expect(host.openCreated).not.toHaveBeenCalled();
  });

  it("deletes through the Trash verb and re-lists the folder", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    await act(async () => read().remove("src/row.tsx", "file"));

    expect(files.delete).toHaveBeenCalledWith({ projectId: "p1", relPath: "src/row.tsx" });
    expect(host.refresh).toHaveBeenCalled();
  });

  it("names the kind of thing that could not be trashed", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    files.delete.mockResolvedValueOnce({ ok: false, error: "Permission was denied" });

    await act(async () => read().remove("src/components", "directory"));

    expect(toastError).toHaveBeenCalledWith(
      "Couldn't move the folder to the Trash: Permission was denied",
    );
    expect(host.refresh).not.toHaveBeenCalled();
  });

  it("surfaces a duplicate that threw rather than swallowing it", async () => {
    const { read, files } = await mount({ projectId: "p1" }, "src");
    files.duplicate.mockRejectedValueOnce(new Error("bridge is gone"));

    await act(async () => read().duplicate("src/row.tsx"));

    expect(toastError).toHaveBeenCalledWith("Couldn't duplicate src/row.tsx: bridge is gone");
  });
});

describe("the inline field's lifetime", () => {
  it("cancels on demand", async () => {
    const { read } = await mount({ projectId: "p1" }, "src");
    await act(async () => read().startRename("src/row.tsx"));
    await act(async () => read().cancelEdit());

    expect(read().edit).toEqual({ kind: "none" });
  });
});
