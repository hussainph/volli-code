import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeSetFile } from "@volli/shared";

import { DiffStub } from "./diff-stub";
import {
  applyDiffDiskReconcilePlan,
  isDiffLeaseCurrent,
  isMissingFileReadError,
  mapBaseReadResult,
  mapFilesReadFailure,
  planDiffDiskReconcile,
  planDiffView,
  type DiffLiveRead,
} from "./diff-view-plan";
import { diffEditorInitFailureMessage } from "@renderer/components/editor/monaco-diff-editor";

function file(overrides: Partial<ChangeSetFile> & Pick<ChangeSetFile, "path">): ChangeSetFile {
  return {
    status: "modified",
    insertions: 1,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

describe("mapBaseReadResult", () => {
  it("maps IPC success arms onto DiffBaseRead", () => {
    expect(mapBaseReadResult({ ok: true, content: "a\n", truncated: false })).toEqual({
      content: "a\n",
    });
    expect(mapBaseReadResult({ ok: true, content: "a\n", truncated: true })).toEqual({
      content: "a\n",
      truncated: true,
    });
    expect(mapBaseReadResult({ ok: true, missing: true })).toEqual({ missing: true });
    expect(mapBaseReadResult({ ok: true, binary: true })).toEqual({ binary: true });
  });

  it("surfaces IPC failures as errors", () => {
    expect(mapBaseReadResult({ ok: false, error: "No worktree" })).toEqual({
      error: "No worktree",
    });
  });
});

describe("isMissingFileReadError / mapFilesReadFailure", () => {
  it("recognizes volli-fs and Node missing-file errors", () => {
    expect(isMissingFileReadError("File was not found")).toBe(true);
    expect(isMissingFileReadError("File no longer exists on disk")).toBe(true);
    expect(isMissingFileReadError("File does not exist on disk")).toBe(true);
    expect(isMissingFileReadError("ENOENT: no such file or directory, stat '/x'")).toBe(true);
    expect(isMissingFileReadError("Permission denied")).toBe(false);
  });

  it("maps missing errors onto the DiffLiveRead missing arm", () => {
    expect(mapFilesReadFailure("File was not found")).toEqual({ ok: false, missing: true });
    expect(mapFilesReadFailure("ENOENT: no such file or directory, open '/x'")).toEqual({
      ok: false,
      missing: true,
    });
    expect(mapFilesReadFailure("Permission denied")).toEqual({
      ok: false,
      error: "Permission denied",
    });
  });
});

describe("planDiffDiskReconcile", () => {
  const liveOk: DiffLiveRead = {
    ok: true,
    text: "agent\n",
    mtime: 99,
    source: "worktree",
    truncated: false,
  };

  it("adopts a clean baseline when disk moved and the draft is clean", () => {
    expect(
      planDiffDiskReconcile({
        dirty: false,
        baseline: "old\n",
        lastWrite: null,
        disk: liveOk,
      }),
    ).toEqual({
      kind: "adopt",
      text: "agent\n",
      revision: 99,
      source: "worktree",
    });
  });

  it("adopts when disk matches baseline so mtime can advance", () => {
    expect(
      planDiffDiskReconcile({
        dirty: false,
        baseline: "agent\n",
        lastWrite: null,
        disk: liveOk,
      }),
    ).toEqual({
      kind: "adopt",
      text: "agent\n",
      revision: 99,
      source: "worktree",
    });
  });

  it("adopts the echo of our own write even when dirty against newer typing", () => {
    expect(
      planDiffDiskReconcile({
        dirty: true,
        baseline: "old\n",
        lastWrite: "agent\n",
        disk: liveOk,
      }),
    ).toEqual({
      kind: "adopt",
      text: "agent\n",
      revision: 99,
      source: "worktree",
    });
  });

  it("diverges when disk moved under a dirty draft that is not our write echo", () => {
    expect(
      planDiffDiskReconcile({
        dirty: true,
        baseline: "old\n",
        lastWrite: null,
        disk: liveOk,
      }),
    ).toEqual({
      kind: "diverged",
      text: "agent\n",
      revision: 99,
    });
  });

  it("keeps a dirty draft when the live file becomes unreadable", () => {
    expect(
      planDiffDiskReconcile({
        dirty: true,
        baseline: "old\n",
        lastWrite: null,
        disk: { ok: false, error: "Permission denied" },
      }),
    ).toEqual({ kind: "unreadable", error: "Permission denied", keepDraft: true });
  });

  it("surfaces a clean missing file as an error transition", () => {
    expect(
      planDiffDiskReconcile({
        dirty: false,
        baseline: "old\n",
        lastWrite: null,
        disk: { ok: false, missing: true },
      }),
    ).toEqual({ kind: "missing" });
  });

  it("treats a dirty missing file as an unreadable keep-draft", () => {
    expect(
      planDiffDiskReconcile({
        dirty: true,
        baseline: "old\n",
        lastWrite: null,
        disk: { ok: false, missing: true },
      }),
    ).toEqual({
      kind: "unreadable",
      error: "File was deleted on disk.",
      keepDraft: true,
    });
  });
});

describe("applyDiffDiskReconcilePlan", () => {
  it("adopts on adopt and clears conflict", () => {
    const adoptCleanBaseline = vi.fn();
    expect(
      applyDiffDiskReconcilePlan({
        plan: { kind: "adopt", text: "new\n", revision: 7, source: "worktree" },
        adoptCleanBaseline,
      }),
    ).toEqual({ kind: "clear-conflict" });
    expect(adoptCleanBaseline).toHaveBeenCalledWith({ value: "new\n", revision: 7 });
  });

  it("adopts externalRevision on diverged before raising the conflict banner", () => {
    const adoptCleanBaseline = vi.fn();
    expect(
      applyDiffDiskReconcilePlan({
        plan: { kind: "diverged", text: "disk\n", revision: 42 },
        adoptCleanBaseline,
      }),
    ).toEqual({ kind: "conflict", conflict: { text: "disk\n", mtime: 42 } });
    // Without this adopt, handleSave would still send the stale expectedMtime
    // even though the banner says "Saving now overwrites".
    expect(adoptCleanBaseline).toHaveBeenCalledWith({ value: "disk\n", revision: 42 });
  });

  it("toasts when unreadable keeps a dirty draft", () => {
    const adoptCleanBaseline = vi.fn();
    expect(
      applyDiffDiskReconcilePlan({
        plan: { kind: "unreadable", error: "gone", keepDraft: true },
        adoptCleanBaseline,
      }),
    ).toEqual({ kind: "toast-unreadable" });
    expect(adoptCleanBaseline).not.toHaveBeenCalled();
  });

  it("errors when unreadable and the draft was clean", () => {
    expect(
      applyDiffDiskReconcilePlan({
        plan: { kind: "unreadable", error: "gone", keepDraft: false },
        adoptCleanBaseline: vi.fn(),
      }),
    ).toEqual({ kind: "error", error: "gone" });
  });

  it("surfaces missing while clean", () => {
    expect(
      applyDiffDiskReconcilePlan({
        plan: { kind: "missing" },
        adoptCleanBaseline: vi.fn(),
      }),
    ).toEqual({ kind: "missing" });
  });
});

describe("planDiffView", () => {
  const live: DiffLiveRead = {
    ok: true,
    text: "live\n",
    mtime: 42,
    source: "worktree",
    truncated: false,
  };

  it("plans a binary stub without an editor", () => {
    expect(
      planDiffView({
        file: file({ path: "logo.png", binary: true, insertions: null, deletions: null }),
        base: { content: "ignored" },
        baseRevision: "abc",
        live,
      }),
    ).toEqual({
      kind: "stub",
      stubReason: "Binary file",
      path: "logo.png",
      previousPath: null,
    });
  });

  it("plans a conflicted stub without an editor", () => {
    expect(
      planDiffView({
        file: file({ path: "merge.ts", status: "conflicted" }),
        base: { content: "base\n" },
        baseRevision: "abc",
        live,
      }),
    ).toEqual({
      kind: "stub",
      stubReason: "Conflicted file",
      path: "merge.ts",
      previousPath: null,
    });
  });

  it("plans an editor with base content and live modified seed", () => {
    expect(
      planDiffView({
        file: file({ path: "src/a.ts" }),
        base: { content: "base\n" },
        baseRevision: "abc123",
        live,
      }),
    ).toMatchObject({
      kind: "editor",
      path: "src/a.ts",
      baseRevision: "abc123",
      originalValue: "base\n",
      modifiedValue: "live\n",
      modifiedRevision: 42,
      modifiedSource: "worktree",
      modifiedReadOnly: false,
    });
  });

  it("marks truncated live text read-only so a prefix can never be saved back", () => {
    expect(
      planDiffView({
        file: file({ path: "logs/huge.txt" }),
        base: { content: "base\n" },
        baseRevision: "abc",
        live: { ...live, text: "prefix…", truncated: true },
      }),
    ).toMatchObject({
      kind: "editor",
      modifiedValue: "prefix…",
      modifiedReadOnly: true,
    });
  });

  it("plans an empty read-only modified side for deletes", () => {
    expect(
      planDiffView({
        file: file({ path: "gone.ts", status: "deleted" }),
        base: { content: "was\n" },
        baseRevision: "abc",
        live: { ok: false, missing: true },
      }),
    ).toMatchObject({
      kind: "editor",
      originalValue: "was\n",
      modifiedValue: "",
      modifiedReadOnly: true,
    });
  });

  it("keeps rename previousPath for the base-side identity path", () => {
    expect(
      planDiffView({
        file: file({
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
        }),
        base: { content: "old\n" },
        baseRevision: "abc",
        live,
      }),
    ).toMatchObject({
      kind: "editor",
      path: "src/new.ts",
      previousPath: "src/old.ts",
      basePath: "src/old.ts",
    });
  });
});

describe("DiffStub", () => {
  it("renders the stub reason for binary/conflicted paths", () => {
    const html = renderToStaticMarkup(
      <DiffStub path="logo.png" previousPath={null} stubReason="Binary file" />,
    );
    expect(html).toContain("Binary file");
    expect(html).toContain("logo.png");
    expect(html).toContain('data-testid="ticket-diff-stub"');
    expect(html).not.toContain("data-monaco-diff");
  });

  it("surfaces Monaco DiffEditor init failure without presentation chrome", () => {
    const html = renderToStaticMarkup(
      <DiffStub
        path="src/app.ts"
        previousPath={null}
        stubReason={diffEditorInitFailureMessage("src/app.ts diff", "WebGL unavailable")}
      />,
    );
    expect(html).toContain("load src/app.ts diff: WebGL unavailable");
    expect(html).toContain('data-testid="ticket-diff-stub"');
    expect(html).not.toContain("ticket-diff-presentation");
  });
});

describe("isDiffLeaseCurrent", () => {
  const leases = { id: "a" };

  it("allows mutation only while mounted and the captured lease is still current", () => {
    expect(isDiffLeaseCurrent({ captured: leases, current: leases, mounted: true })).toBe(true);
  });

  it("bails after await when the load effect replaced the leases", () => {
    expect(
      isDiffLeaseCurrent({
        captured: leases,
        current: { id: "b" },
        mounted: true,
      }),
    ).toBe(false);
  });

  it("bails after await when the component unmounted", () => {
    expect(isDiffLeaseCurrent({ captured: leases, current: leases, mounted: false })).toBe(false);
  });

  it("bails when either side is null", () => {
    expect(isDiffLeaseCurrent({ captured: null, current: leases, mounted: true })).toBe(false);
    expect(isDiffLeaseCurrent({ captured: leases, current: null, mounted: true })).toBe(false);
  });
});
