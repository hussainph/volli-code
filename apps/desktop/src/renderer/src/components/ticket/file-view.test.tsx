// @vitest-environment jsdom
/**
 * The markdown file tab itself: which view it offers, which one it mounts, and
 * what switching between them is allowed to do to the file (VC-192, VC-307).
 *
 * Round 1 of this work tested the Preview surface and the pure policy in
 * isolation and left the TAB untested — a review mutation that simply turned
 * the Preview branch off here left every other test green. So these mount the
 * real `FileView` over a stubbed bridge, with Monaco replaced by a recorder
 * (it cannot be constructed in jsdom, and what is under test is the host's
 * decisions, not the editor's).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const monaco = vi.hoisted(() => ({
  /** Every props object the source editor was rendered with, in order. */
  renders: [] as Record<string, unknown>[],
}));

vi.mock("@renderer/components/editor/monaco-file-editor", () => ({
  MonacoFileEditor: (props: Record<string, unknown>) => {
    monaco.renders.push(props);
    return (
      <div
        data-testid="monaco-file-editor"
        data-surface={String(props["surface"])}
        data-value={String(props["value"])}
      />
    );
  },
}));

vi.mock("@renderer/components/editor/monaco-document-editor", () => ({
  MonacoDocumentEditor: () => <div data-testid="monaco-document-editor" />,
}));

vi.mock("@renderer/editor/monaco-runtime", () => ({
  loadMonacoRuntime: vi.fn(async () => {
    throw new Error("Monaco is not loaded in tests");
  }),
}));

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

import { useWorkspaceStore } from "@renderer/stores/workspace";
import { FileView, overwriteAutosaveConflict } from "./file-view";

describe("overwriteAutosaveConflict", () => {
  it("writes the exact retained draft against the newer disk revision", async () => {
    const write = vi.fn().mockResolvedValue({ ok: true, mtime: 31 });

    const result = await overwriteAutosaveConflict({
      draft: "exact human draft\n",
      diskRevision: 29,
      write,
    });

    expect(write).toHaveBeenCalledWith({
      content: "exact human draft\n",
      expectedMtime: 29,
    });
    expect(result).toEqual({ ok: true, mtime: 31 });
  });
});

/** A file the Document projection refuses: the repository README's own shape. */
const RAW_HTML = `<p align="center">
  <b>Volli Code</b>
</p>

# Volli Code

Prose that reads perfectly well.
`;

/** A file it accepts. */
const PLAIN = "# Notes\n\nOrdinary prose.\n";

const PROJECT = "project-1";

let root: Root | null = null;
let container: HTMLElement | null = null;
let read: ReturnType<typeof vi.fn>;
let write: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  monaco.renders.length = 0;
  read = vi.fn(async ({ relPath }: { relPath: string }) => ({
    ok: true as const,
    source: "main" as const,
    kind: "markdown" as const,
    size: 10,
    mtime: 7,
    content: {
      type: "text" as const,
      text: relPath === "README.md" ? RAW_HTML : PLAIN,
      truncated: false,
    },
  }));
  write = vi.fn(async () => ({ ok: true as const, mtime: 8 }));
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      files: {
        read,
        write,
        watch: vi.fn(async () => ({ ok: true })),
        unwatch: vi.fn(async () => ({ ok: true })),
        onChanged: vi.fn(() => () => {}),
      },
    },
  });
  useWorkspaceStore.setState({ byProject: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  useWorkspaceStore.setState({ byProject: {} });
  vi.unstubAllGlobals();
});

async function openFile(
  relPath: string,
  props: { onDirtyChange?: (dirty: boolean) => void } = {},
): Promise<HTMLElement> {
  await act(async () => {
    root?.render(<FileView projectId={PROJECT} relPath={relPath} {...props} />);
  });
  if (container === null) throw new Error("missing test container");
  return container;
}

/** Press one segment of the markdown view band. */
async function choose(view: "source" | "document" | "preview"): Promise<void> {
  const button = container?.querySelector<HTMLButtonElement>(`button[data-choice="${view}"]`);
  if (!button) throw new Error(`no ${view} segment on screen`);
  await act(async () => {
    button.click();
  });
}

const previewPane = () => container?.querySelector('[data-testid="markdown-preview"]') ?? null;
const sourcePane = () => container?.querySelector('[data-testid="monaco-file-editor"]') ?? null;
const lastEditorProps = () => monaco.renders.at(-1);

describe("FileView — the markdown view band", () => {
  it("offers Source and read-only Preview for a file Document view refuses", async () => {
    const view = await openFile("README.md");

    expect(view.querySelector('button[data-choice="source"]')).not.toBeNull();
    expect(view.querySelector('button[data-choice="preview"]')).not.toBeNull();
    // Document stays on screen, disabled, with the reason beside it.
    expect(view.querySelector<HTMLButtonElement>('button[data-choice="document"]')?.disabled).toBe(
      true,
    );
    expect(view.textContent).toContain("show this file");
    // Source is still what opens: the choice is offered, never imposed.
    expect(sourcePane()).not.toBeNull();
    expect(previewPane()).toBeNull();
  });

  it("mounts the Preview surface when Preview is chosen, in place of the editor", async () => {
    await openFile("README.md");

    await choose("preview");

    expect(previewPane()).not.toBeNull();
    expect(sourcePane()).toBeNull();
    // It is the file that is drawn, not a placeholder.
    expect(container?.textContent).toContain("Prose that reads perfectly well.");
  });

  it("offers only the editable pair for a file the projection accepts", async () => {
    const view = await openFile("docs/NOTES.md");

    expect(view.querySelector('button[data-choice="preview"]')).toBeNull();
    expect(view.querySelector<HTMLButtonElement>('button[data-choice="document"]')?.disabled).toBe(
      false,
    );

    await choose("document");
    expect(sourcePane()?.getAttribute("data-surface")).toBe("document");
  });

  it("drops a remembered Preview choice once the file can be edited as a document", async () => {
    // The same path in both cases: the preference is remembered for the FILE,
    // and the bytes get the last word.
    useWorkspaceStore.getState().setMarkdownFileView(PROJECT, "docs/NOTES.md", "preview");

    const view = await openFile("docs/NOTES.md");

    expect(previewPane()).toBeNull();
    expect(sourcePane()?.getAttribute("data-surface")).toBe("source");
    expect(view.querySelector('button[data-choice="preview"]')).toBeNull();
  });
});

describe("FileView — Preview only ever reads", () => {
  it("writes nothing when the tab is opened, switched to Preview, and switched back", async () => {
    await openFile("README.md");

    await choose("preview");
    expect(previewPane()).not.toBeNull();
    await choose("source");

    expect(write).not.toHaveBeenCalled();
  });

  it("keeps an unsaved Source draft across a visit to Preview", async () => {
    const onDirtyChange = vi.fn();
    await openFile("README.md", { onDirtyChange });

    // The editor reports a draft, exactly as Monaco's own dirty state would.
    const reportDirty = lastEditorProps()?.["onDirtyChange"] as (dirty: boolean) => void;
    await act(async () => {
      reportDirty(true);
    });
    const readsBefore = read.mock.calls.length;

    await choose("preview");

    // The tab still knows it holds unsaved work — the close guard never blinked —
    // and the band says the page is not showing it.
    expect(previewPane()).not.toBeNull();
    expect(onDirtyChange.mock.calls).toEqual([[true]]);
    expect(container?.textContent).toContain("Unsaved");
    expect(write).not.toHaveBeenCalled();

    await choose("source");

    // Back on the same bytes, from the same read: nothing re-loaded the file,
    // and nothing re-seeded the shared document the draft lives in.
    expect(lastEditorProps()?.["value"]).toBe(RAW_HTML);
    expect(lastEditorProps()?.["revision"]).toBe(7);
    expect(read.mock.calls.length).toBe(readsBefore);
    expect(onDirtyChange.mock.calls).toEqual([[true]]);
  });
});
