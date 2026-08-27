import { describe, expect, it } from "vite-plus/test";
import type { FileWorkspaceTab, IndexedFile } from "@volli/shared";

import { HOME_BOARD_TAB_ID } from "@renderer/components/home/home-tabs";
import { TICKET_BODY_TAB_ID } from "@renderer/components/ticket/ticket-body-tab";
import { chatTabId } from "@renderer/components/ticket/ticket-chat-tab";
import { fileTabId } from "@renderer/components/ticket/ticket-file-tab";
import { DEFAULT_WORKSPACE_UI, type WorkspaceUiState } from "@renderer/stores/workspace";

import {
  MAX_QUICK_OPEN_RESULTS,
  quickOpenIntent,
  quickOpenRows,
  quickOpenScope,
  quickOpenSurfaceFiles,
} from "./quick-open-model";

function indexed(relPath: string, artifact = false): IndexedFile {
  return { relPath, kind: "other", artifact };
}

function tab(relPath: string, pinned: boolean): FileWorkspaceTab {
  return { relPath, pinned };
}

function workspace(overrides: Partial<WorkspaceUiState> = {}): WorkspaceUiState {
  return { ...DEFAULT_WORKSPACE_UI, ...overrides };
}

describe("quickOpenScope", () => {
  const base = {
    projectId: "p1",
    nav: "home" as const,
    homeActiveTab: HOME_BOARD_TAB_ID,
    openTicketId: null as string | null,
  };

  it("answers null with no project selected — there is no checkout to search", () => {
    expect(quickOpenScope({ ...base, projectId: null })).toBeNull();
  });

  it("searches Main when Home's board is in front", () => {
    expect(quickOpenScope(base)).toEqual({ kind: "home", projectId: "p1" });
  });

  it("searches the ticket's worktree when a Ticket workspace has taken the Board tab over", () => {
    expect(quickOpenScope({ ...base, openTicketId: "t1" })).toEqual({
      kind: "ticket",
      projectId: "p1",
      ticketId: "t1",
    });
  });

  it("searches Main from a Home Session tab, even with a ticket remembered behind it", () => {
    // VC-54: `openHome` leaves `openTicketId` alone, so the remembered ticket
    // is not the surface — the Session tab in front is, and it is Home's.
    expect(quickOpenScope({ ...base, homeActiveTab: chatTabId("s1"), openTicketId: "t1" })).toEqual(
      { kind: "home", projectId: "p1" },
    );
  });

  it("searches Main from a Home File tab", () => {
    expect(
      quickOpenScope({ ...base, homeActiveTab: fileTabId("README.md"), openTicketId: "t1" }),
    ).toEqual({ kind: "home", projectId: "p1" });
  });

  it("searches Main from Configure, which opening navigates back to Home from", () => {
    expect(quickOpenScope({ ...base, nav: "configure", openTicketId: "t1" })).toEqual({
      kind: "home",
      projectId: "p1",
    });
  });
});

describe("quickOpenSurfaceFiles", () => {
  it("reads Home's own strip for a home scope", () => {
    const ui = workspace({
      projectFiles: { tabs: [tab("README.md", false)], activeRelPath: "README.md" },
      homeActiveTab: fileTabId("README.md"),
    });
    expect(quickOpenSurfaceFiles({ kind: "home", projectId: "p1" }, ui)).toEqual({
      tabs: [tab("README.md", false)],
      activeFileRelPath: "README.md",
    });
  });

  it("reports no active file when a non-file Home tab is in front", () => {
    const ui = workspace({ homeActiveTab: HOME_BOARD_TAB_ID });
    expect(
      quickOpenSurfaceFiles({ kind: "home", projectId: "p1" }, ui).activeFileRelPath,
    ).toBeNull();
  });

  it("reads THAT ticket's strip for a ticket scope, never Home's", () => {
    // Decision #54: the same relPath in two checkouts is two documents, so the
    // scope that chose the index must choose the strip too.
    const ui = workspace({
      projectFiles: { tabs: [tab("README.md", false)], activeRelPath: "README.md" },
      homeActiveTab: fileTabId("README.md"),
      ticketTabs: {
        t1: { files: [tab("app.ts", false)], diffs: [], diffMeta: {}, active: fileTabId("app.ts") },
      },
    });
    expect(quickOpenSurfaceFiles({ kind: "ticket", projectId: "p1", ticketId: "t1" }, ui)).toEqual({
      tabs: [tab("app.ts", false)],
      activeFileRelPath: "app.ts",
    });
  });

  it("reports no active file when the ticket's Body tab is in front", () => {
    const ui = workspace({
      ticketTabs: { t1: { files: [], diffs: [], diffMeta: {}, active: TICKET_BODY_TAB_ID } },
    });
    expect(
      quickOpenSurfaceFiles({ kind: "ticket", projectId: "p1", ticketId: "t1" }, ui)
        .activeFileRelPath,
    ).toBeNull();
  });

  it("answers an empty strip for a ticket workspace never opened", () => {
    expect(
      quickOpenSurfaceFiles({ kind: "ticket", projectId: "p1", ticketId: "t1" }, workspace()),
    ).toEqual({ tabs: [], activeFileRelPath: null });
  });
});

describe("quickOpenRows", () => {
  it("ranks by the @ picker's own matcher, best first", () => {
    const rows = quickOpenRows({
      query: "main",
      index: [indexed("a/b/c/d/main.ts"), indexed("main.ts"), indexed("src/other.ts")],
    });
    expect(rows.map((row) => row.relPath)).toEqual(["main.ts", "a/b/c/d/main.ts"]);
  });

  it("splits each row into the name searched for and the folder that disambiguates it", () => {
    const rows = quickOpenRows({ query: "main", index: [indexed("src/app/main.ts")] });
    expect(rows[0]).toEqual({
      relPath: "src/app/main.ts",
      label: "main.ts",
      detail: "src/app",
      artifact: false,
    });
  });

  it("carries the artifact flag the shared ranking already favours", () => {
    const rows = quickOpenRows({
      query: "notes",
      index: [indexed("notes.md"), indexed(".volli/artifacts/notes.md", true)],
    });
    expect(rows[0]?.relPath).toBe(".volli/artifacts/notes.md");
    expect(rows[0]?.artifact).toBe(true);
  });

  it("offers files the @ grammar cannot spell — quick-open writes no ref", () => {
    // `isExpressibleRefPath` rejects spaces, so the `@` picker drops this file.
    // It is still perfectly openable, which is the whole reason the filter
    // stayed at that call site instead of moving into the shared ranking.
    const rows = quickOpenRows({ query: "design", index: [indexed("docs/design notes.md")] });
    expect(rows.map((row) => row.relPath)).toEqual(["docs/design notes.md"]);
  });

  it("drops non-matches", () => {
    const rows = quickOpenRows({ query: "xyz", index: [indexed("src/main.ts")] });
    expect(rows).toEqual([]);
  });

  it("shows the index's most plausible entries for an empty query", () => {
    const rows = quickOpenRows({ query: "", index: [indexed("a/b/c/deep.ts"), indexed("top.ts")] });
    expect(rows.map((row) => row.relPath)).toEqual(["top.ts", "a/b/c/deep.ts"]);
  });

  it("treats a whitespace-only query as empty rather than matching nothing", () => {
    const rows = quickOpenRows({ query: "  ", index: [indexed("top.ts")] });
    expect(rows.map((row) => row.relPath)).toEqual(["top.ts"]);
  });

  it("bounds the list — a jump list, not a search result page", () => {
    const index = Array.from({ length: MAX_QUICK_OPEN_RESULTS + 10 }, (_unused, n) =>
      indexed(`src/main${n}.ts`),
    );
    expect(quickOpenRows({ query: "main", index })).toHaveLength(MAX_QUICK_OPEN_RESULTS);
  });
});

describe("quickOpenIntent", () => {
  it("previews a file the surface has never opened", () => {
    expect(
      quickOpenIntent({ relPath: "a.ts", pin: false, tabs: [], activeFileRelPath: null }),
    ).toBe("preview");
  });

  it("pins on the explicit ⌘Enter gesture", () => {
    expect(quickOpenIntent({ relPath: "a.ts", pin: true, tabs: [], activeFileRelPath: null })).toBe(
      "pin",
    );
  });

  it("pins on a second invoke of the file it just previewed", () => {
    expect(
      quickOpenIntent({
        relPath: "a.ts",
        pin: false,
        tabs: [tab("a.ts", false)],
        activeFileRelPath: "a.ts",
      }),
    ).toBe("pin");
  });

  it("previews a file open in the preview slot that is NOT in front — that is a first invoke", () => {
    expect(
      quickOpenIntent({
        relPath: "a.ts",
        pin: false,
        tabs: [tab("a.ts", false)],
        activeFileRelPath: "b.ts",
      }),
    ).toBe("preview");
  });

  it("previews (activates) an already-pinned tab rather than re-pinning it", () => {
    expect(
      quickOpenIntent({
        relPath: "a.ts",
        pin: false,
        tabs: [tab("a.ts", true)],
        activeFileRelPath: "a.ts",
      }),
    ).toBe("preview");
  });

  it("previews when the active tab id names a file with no tab record", () => {
    // Defensive: the active-tab record and the tab list are two fields, and a
    // stale record must not be read as "you already previewed this".
    expect(
      quickOpenIntent({ relPath: "a.ts", pin: false, tabs: [], activeFileRelPath: "a.ts" }),
    ).toBe("preview");
  });
});
