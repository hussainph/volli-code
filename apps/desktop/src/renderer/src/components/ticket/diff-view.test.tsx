import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeSetFile } from "@volli/shared";

import { DiffStub } from "./diff-stub";
import {
  applyDiffLiveReconciliation,
  reconcileAcquiredDiffModel,
  isDiffLeaseCurrent,
  isMissingFileReadError,
  mapBaseReadResult,
  mapFilesReadFailure,
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

describe("applyDiffLiveReconciliation", () => {
  it("uses the shared File/Diff policy and registry transaction for disjoint edits", () => {
    const applyExternalUpdate = vi.fn();
    const lease = {
      model: { getValue: () => "human first\nkeep\nlast\n" },
      snapshot: () => ({ baseline: "first\nkeep\nlast\n" }),
      applyExternalUpdate,
      adoptCleanBaseline: vi.fn(),
    };

    const result = applyDiffLiveReconciliation({
      lease,
      lastWrite: null,
      disk: {
        ok: true,
        text: "first\nkeep\nagent last\n",
        mtime: 21,
        source: "worktree",
        truncated: false,
      },
      unreadableRevision: null,
    });

    expect(result).toMatchObject({ kind: "apply", outcome: "merge" });
    expect(applyExternalUpdate).toHaveBeenCalledWith({
      baseline: "first\nkeep\nagent last\n",
      value: "human first\nkeep\nagent last\n",
      revision: 21,
    });
  });

  it("reconciles the live disk value when Diff acquires an existing dirty file model", () => {
    const adoptCleanBaseline = vi.fn();
    const lease = {
      model: { getValue: () => "human line\n" },
      snapshot: () => ({ baseline: "baseline\n" }),
      applyExternalUpdate: vi.fn(),
      adoptCleanBaseline,
    };

    const result = reconcileAcquiredDiffModel({
      lease,
      existing: true,
      lastWrite: null,
      disk: {
        ok: true,
        text: "agent line\n",
        mtime: 24,
        source: "worktree",
        truncated: false,
      },
    });

    expect(result).toMatchObject({
      kind: "conflict",
      local: "human line\n",
      disk: "agent line\n",
      revision: 24,
    });
    expect(adoptCleanBaseline).toHaveBeenCalledWith({ value: "agent line\n", revision: 24 });
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
