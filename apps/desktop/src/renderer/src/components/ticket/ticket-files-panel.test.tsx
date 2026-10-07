// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BlobLinkView, NamedBlobLink, Ticket } from "@volli/shared";

import { TicketFilesList, TicketFilesPanel } from "./ticket-files-panel";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import {
  clearRememberedNavigatorViews,
  navigatorScopeKey,
  writeNavigatorView,
} from "@renderer/components/files/navigator-scope-state";
import type { FileNavigatorControls } from "@renderer/components/files/use-navigator-mutations";
import type { NavigatorEdit } from "@renderer/components/files/navigator-mutations";
import type { ListDirectoryResult } from "../../../../ipc/contract";
import type { TicketFileRefRow, TicketWorktreeEntry } from "./ticket-files-model";

const noop = (_path: string): void => {};

/** A controller that only reports which field is open — enough for the drawing. */
function controlsWith(edit: NavigatorEdit): FileNavigatorControls {
  return {
    edit,
    canWrite: true,
    startDraft: () => {},
    startRename: () => {},
    cancelEdit: () => {},
    commitDraft: () => {},
    commitRename: () => {},
    duplicate: () => {},
    remove: () => {},
  };
}

function render(
  referenced: TicketFileRefRow[],
  worktree: TicketWorktreeEntry[],
  controls?: FileNavigatorControls,
  empty?: { canClaimEmpty?: boolean; emptyLabel?: string },
): string {
  // Row actions are tooltip triggers, and the real tree always has a provider
  // (SidebarProvider wraps the whole app).
  return renderToStaticMarkup(
    <TooltipProvider>
      <TicketFilesList
        projectId="project-1"
        ticketId="ticket-1"
        referenced={referenced}
        worktree={worktree}
        controls={controls}
        {...empty}
        onPreviewFile={noop}
        onPinFile={noop}
        onOpenDirectory={noop}
      />
    </TooltipProvider>,
  );
}

describe("TicketFilesList", () => {
  it("renders worktree entries and referenced context as one flat list", () => {
    const html = render(
      [
        { relPath: "src/rail.tsx", label: "rail.tsx", source: "body" },
        { relPath: ".volli/attachments/spec.png", label: "homepage mock", source: "attachment" },
      ],
      [
        { relPath: "README.md", kind: "file" },
        { relPath: "src", kind: "directory" },
      ],
    );

    expect(html).toContain("rail.tsx");
    expect(html).toContain("homepage mock");
    expect(html).toContain("README.md");
    expect(html).toContain('data-testid="ticket-files-list"');
    // One list, not a section per kind — the row's own mark and its hover
    // title say which rows are referenced context.
    expect(html).toContain("Referenced · src/rail.tsx");
    expect(html.match(/<ul/g)?.length).toBe(1);
    expect(html).not.toContain("<ul><ul>");
  });

  it("draws 36px one-line entries without repeating the folder under each name", () => {
    const html = render(
      [],
      [
        { relPath: "src/rail.tsx", kind: "file" },
        { relPath: "src/files", kind: "directory" },
      ],
    );

    // The parent path was the second line on every row, and in a
    // current-folder listing it is the folder the header already names.
    expect(html).not.toContain("min-h-13");
    expect(html).not.toContain('text-muted-foreground/70">src<');
    expect(html).toContain("rail.tsx");
  });

  it("keeps a referenced row's own location, which is not the folder on screen", () => {
    const html = render([{ relPath: "docs/DESIGN.md", label: "DESIGN.md", source: "body" }], []);

    expect(html).toContain("docs");
    expect(html).toContain("Referenced · docs/DESIGN.md");
  });

  it("puts the worktree first and referenced context after it", () => {
    const html = render(
      [{ relPath: "docs/DESIGN.md", label: "DESIGN.md", source: "body" }],
      [{ relPath: "README.md", kind: "file" }],
    );

    expect(html.indexOf("README.md")).toBeLessThan(html.indexOf("DESIGN.md"));
  });

  it("marks a directory with a trailing slash and no open-in-tab action", () => {
    const html = render([], [{ relPath: "src", kind: "directory" }]);

    expect(html).toContain("src/");
    expect(html).not.toContain('aria-label="Open src in tab"');
  });

  it("shows an empty hint when there is nothing to list", () => {
    expect(render([], [])).toContain("Nothing here yet");
  });

  it("says nothing at all until a read has landed (VC-406)", () => {
    // "Nothing here yet" is a claim about what a read RETURNED; a list with no
    // completed read is not entitled to make it, and its panel is already
    // saying why there is nothing.
    expect(render([], [], undefined, { canClaimEmpty: false })).toBe("");
  });

  it("lets the panel name what an empty-but-read listing means", () => {
    const html = render([], [], undefined, { emptyLabel: "No matches" });

    expect(html).toContain("No matches");
    expect(html).not.toContain("Nothing here yet");
  });
});

describe("TicketFilesList inline edits (VC-191)", () => {
  it("opens a rename field in the row itself, and takes the row's own activation away", () => {
    const html = render(
      [],
      [{ relPath: "src/row.tsx", kind: "file" }],
      controlsWith({ kind: "rename", relPath: "src/row.tsx" }),
    );

    expect(html).toContain('aria-label="Rename row.tsx"');
    // An input inside the activating button would nest an interactive control
    // and preview the file on every click into the field.
    expect(html).not.toContain('aria-label="Open src/row.tsx in tab"');
  });

  it("leaves every other row alone while one is being renamed", () => {
    const html = render(
      [],
      [
        { relPath: "src/row.tsx", kind: "file" },
        { relPath: "src/list.tsx", kind: "file" },
      ],
      controlsWith({ kind: "rename", relPath: "src/row.tsx" }),
    );

    expect(html).toContain('aria-label="Open src/list.tsx in tab"');
    expect(html).not.toContain('aria-label="Rename list.tsx"');
  });

  it.each([
    ["file", "New file name"],
    ["directory", "New folder name"],
  ] as const)("puts an unnamed %s row at the top of the listing", (entry, label) => {
    const html = render(
      [],
      [{ relPath: "src/row.tsx", kind: "file" }],
      controlsWith({ kind: "draft", entry }),
    );

    expect(html).toContain(`aria-label="${label}"`);
    expect(html.indexOf(label)).toBeLessThan(html.indexOf("row.tsx"));
  });

  it("draws the draft row in an EMPTY folder, where New File is most needed", () => {
    const html = render([], [], controlsWith({ kind: "draft", entry: "file" }));

    expect(html).toContain('aria-label="New file name"');
    expect(html).not.toContain("Nothing here yet");
  });
});

/**
 * VC-406 review: the panel WITHOUT a worktree, and the panel handed a different
 * ticket — the two cases where the page used to answer with something that was
 * not about the Ticket in front of it.
 */
const TICKET: Ticket = {
  id: "ticket-1",
  projectId: "project-1",
  ticketNumber: 406,
  title: "Reorganize the rail",
  body: "",
  status: "todo",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  preferredHarnessId: null,
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: "main",
  prUrl: null,
  createdAt: 0,
  updatedAt: 0,
} as unknown as Ticket;

const PDF: BlobLinkView = {
  linkId: "link-1",
  blobHash: "hash-1",
  label: "spec",
  originalName: "spec.pdf",
  mime: "application/pdf",
  sizeBytes: 12,
};

/** The same PDF as a HOST's read-only view of it — a list this panel may not touch. */
const HOST_PDF: NamedBlobLink = {
  linkId: "link-1",
  blobHash: "hash-1",
  label: "spec",
  originalName: "spec.pdf",
};

function drawn(selector: string): Element[] {
  return [...document.querySelectorAll(selector)];
}

function file(): File {
  return new window.File(["x"], "spec.pdf", { type: "application/pdf" });
}

function dropOf(dropped: File): Event {
  const event = new window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files: [dropped] } });
  return event;
}

function pasteOf(pasted: File): Event {
  const event = new window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [pasted] } });
  return event;
}

/** Presses the header's paperclip, so the menu's own surface is mounted. */
async function openAttachments(): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[data-testid="rail-attachments-trigger"]',
  );
  if (trigger === null) throw new Error("no paperclip in the Files header");
  await act(async () => {
    trigger.click();
  });
}

describe("TicketFilesPanel", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let listDirectory = vi.fn();
  let attach = vi.fn();
  let removeBlob = vi.fn();

  /** The panel's whole IPC surface, with `blobs` as the ticket's attachments. */
  function api(blobs: readonly BlobLinkView[], listing?: () => Promise<ListDirectoryResult>) {
    listDirectory = vi.fn(
      listing ?? (async (): Promise<ListDirectoryResult> => ({ ok: true, entries: [] })),
    );
    attach = vi.fn(async () => ({ ok: true, relPath: null, blob: PDF }));
    removeBlob = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, "api", {
      configurable: true,
      value: {
        fs: { listDirectory },
        files: { listExternalApps: async () => ({ ok: true, apps: [] }) },
        attachments: {
          list: async () => ({ ok: true, blobs: [...blobs] }),
          attach,
          remove: removeBlob,
          pathForFile: () => "",
        },
      },
    });
  }

  async function show(
    ticket: Ticket,
    extra: { attachments?: readonly NamedBlobLink[] } = {},
  ): Promise<void> {
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <TicketFilesPanel
            ticket={ticket}
            {...extra}
            onPreviewFile={noop}
            onPinFile={noop}
            onOpenCreatedFile={noop}
            onRenameFile={() => {}}
          />
        </TooltipProvider>,
      );
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // The menu is a popover, and Radix's positioning measures its content.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
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
    document.querySelectorAll('[data-slot="popover-content"]').forEach((node) => node.remove());
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "api");
    clearRememberedNavigatorViews();
  });

  describe("before the ticket has a worktree", () => {
    // Attachments hang off the TICKET, so nothing about them waits on a
    // checkout. The page used to return the no-worktree notice INSTEAD of
    // itself, which took the attachments, Attach, remove and the rail's drop
    // target with it — a file attached to a ticket before its worktree existed
    // had no surface here at all.
    it("keeps the paperclip and Attach available with nothing to list", async () => {
      api([]);

      await show(TICKET);

      expect(drawn('[data-testid="ticket-files-panel"]')).toHaveLength(1);
      expect(drawn('[data-testid="rail-attachments-trigger"]')).toHaveLength(1);
      // Nothing permanent: no eyebrow, no chip strip, no list until it is asked
      // for (VC-406, revision 06).
      expect(document.body.textContent).not.toContain("Ticket files");
      expect(drawn('[data-testid="rail-attachments-list"]')).toHaveLength(0);
      expect(drawn('button[aria-label="Attach files"]')).toHaveLength(0);

      await openAttachments();

      expect(drawn('button[aria-label="Attach files"]')).toHaveLength(1);
      // Honest about the listing rather than about the Ticket: no rows, and
      // where rows would come from.
      expect(drawn('[data-testid="ticket-files-no-worktree"]')).toHaveLength(1);
      expect(drawn('[data-testid="ticket-files-row"]')).toHaveLength(0);
    });

    it("refuses folder mutations that would land in the main checkout", async () => {
      api([]);

      await show(TICKET);

      expect(drawn('button[aria-label="New file"]')).toHaveLength(0);
    });

    it("shows an attachment with no repository path, and lets it be removed", async () => {
      api([PDF]);

      await show(TICKET);
      // The count is what the closed paperclip says: something is attached.
      expect(
        document
          .querySelector('[data-testid="rail-attachments-trigger"]')
          ?.getAttribute("aria-label"),
      ).toBe("Attachments (1)");

      await openAttachments();

      expect(drawn('[data-testid="rail-attachments-list"]')).toHaveLength(1);
      expect(document.body.textContent).toContain("spec");
      const remove = document.querySelector<HTMLButtonElement>('button[aria-label="Remove spec"]');
      expect(remove).not.toBeNull();

      await act(async () => {
        remove?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });

      expect(removeBlob).toHaveBeenCalledWith({ linkId: "link-1" });
      expect(drawn('[data-testid="rail-attachment-row"]')).toHaveLength(0);
    });

    it("stays read-only over a list its host supplied", async () => {
      api([]);

      await show(TICKET, { attachments: [HOST_PDF] });
      await openAttachments();

      expect(document.body.textContent).toContain("spec");
      // A view of someone else's list may not mutate it — neither verb is here,
      // and the picker that would open a dialog is not mounted at all.
      expect(drawn('button[aria-label="Remove spec"]')).toHaveLength(0);
      expect(drawn('button[aria-label="Attach files"]')).toHaveLength(0);
      expect(drawn("input[data-composer-file-picker]")).toHaveLength(0);
    });

    it("accepts a file dropped on the rail", async () => {
      api([]);
      await show(TICKET);
      const panel = document.querySelector('[data-testid="ticket-files-panel"]');

      await act(async () => {
        panel?.dispatchEvent(dropOf(file()));
      });

      expect(attach).toHaveBeenCalledTimes(1);
      expect(attach.mock.calls[0]?.[0]).toMatchObject({
        fileName: "spec.pdf",
        owner: { ticketId: "ticket-1" },
      });
    });

    it("accepts a file pasted onto the rail", async () => {
      api([]);
      await show(TICKET);
      const panel = document.querySelector('[data-testid="ticket-files-panel"]');

      await act(async () => {
        panel?.dispatchEvent(pasteOf(file()));
      });

      expect(attach).toHaveBeenCalledTimes(1);
      expect(attach.mock.calls[0]?.[0]).toMatchObject({ fileName: "spec.pdf" });
    });

    it("refuses a drop and a paste over a list its host supplied", async () => {
      // The menu above is read-only over someone else's list, and the surface
      // under it has to refuse the same thing: a drop that attached here would
      // mutate a list this panel is only a view of.
      api([]);
      await show(TICKET, { attachments: [HOST_PDF] });
      const panel = document.querySelector('[data-testid="ticket-files-panel"]');

      await act(async () => {
        panel?.dispatchEvent(dropOf(file()));
        panel?.dispatchEvent(pasteOf(file()));
      });

      expect(attach).not.toHaveBeenCalled();
    });
  });

  describe("while the reader walks the listing", () => {
    const WITH_WORKTREE: Ticket = {
      ...TICKET,
      worktreePath: "/worktrees/VC-406",
      branch: "volli/VC-406",
    } as Ticket;

    // The menu is in the header rather than in the list precisely so that
    // neither walking into a folder nor narrowing the listing can take the
    // Ticket's attachments away.
    it("keeps the paperclip reachable inside a folder with the filter open", async () => {
      writeNavigatorView(
        navigatorScopeKey("files", { projectId: "project-1", ticketId: "ticket-1" }),
        { cwd: "src/renderer", filtering: true, query: "rail" },
      );
      api([PDF], async () => ({ ok: true, entries: [{ name: "rail.tsx", kind: "file" }] }));

      await show(WITH_WORKTREE);

      expect(listDirectory).toHaveBeenLastCalledWith("/worktrees/VC-406/src/renderer");
      expect(drawn('[data-testid="ticket-files-up"]')).toHaveLength(1);
      expect(document.querySelector("input")?.value).toBe("rail");
      expect(drawn('[data-testid="ticket-files-row"]')).toHaveLength(1);

      await openAttachments();

      expect(drawn('[data-testid="rail-attachments-list"]')).toHaveLength(1);
      expect(document.body.textContent).toContain("spec");
    });
  });

  describe("when the ticket under it is swapped", () => {
    const WITH_WORKTREE: Ticket = {
      ...TICKET,
      worktreePath: "/worktrees/VC-406",
      branch: "volli/VC-406",
    } as Ticket;

    /** Listings whose answers the test hands out one at a time. */
    function deferredListings(): ((result: ListDirectoryResult) => void)[] {
      const queue: ((result: ListDirectoryResult) => void)[] = [];
      api([], async () => await new Promise<ListDirectoryResult>((resolve) => queue.push(resolve)));
      return queue;
    }

    it("draws no trace of the previous ticket in the frame the new one arrives", async () => {
      const reads = deferredListings();
      await show(WITH_WORKTREE);
      await act(async () => {
        reads.pop()?.({ ok: true, entries: [{ name: "README.md", kind: "file" }] });
      });
      expect(drawn('[data-testid="ticket-files-row"]')).toHaveLength(1);
      const before = document.querySelector('[data-testid="ticket-files-panel"]');

      await show({ ...WITH_WORKTREE, id: "ticket-2", branch: "volli/VC-407" } as Ticket);

      const after = document.querySelector('[data-testid="ticket-files-panel"]');
      expect(after).not.toBe(before);
      expect(before?.isConnected).toBe(false);
      expect(drawn('[data-testid="ticket-files-row"]')).toHaveLength(0);
      expect(document.body.textContent).not.toContain("README.md");
      expect(drawn('[data-testid="ticket-files-loading"]')).toHaveLength(1);
    });

    it("lets a listing the old ticket left in flight write nothing here", async () => {
      const reads = deferredListings();
      await show(WITH_WORKTREE);

      await show({ ...WITH_WORKTREE, id: "ticket-2", branch: "volli/VC-407" } as Ticket);
      // The read the first ticket left behind, answering after the swap.
      await act(async () => {
        reads.shift()?.({ ok: true, entries: [{ name: "stale.md", kind: "file" }] });
      });

      expect(document.body.textContent).not.toContain("stale.md");
      expect(drawn('[data-testid="ticket-files-row"]')).toHaveLength(0);
    });
  });
});
