import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeSetFile } from "@volli/shared";

import { DiffStub, mapBaseReadResult, planDiffView, type DiffLiveRead } from "./diff-view";

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
    expect(mapBaseReadResult({ ok: true, content: "a\n" })).toEqual({ content: "a\n" });
    expect(mapBaseReadResult({ ok: true, missing: true })).toEqual({ missing: true });
    expect(mapBaseReadResult({ ok: true, binary: true })).toEqual({ binary: true });
  });

  it("surfaces IPC failures as errors", () => {
    expect(mapBaseReadResult({ ok: false, error: "No worktree" })).toEqual({
      error: "No worktree",
    });
  });
});

describe("planDiffView", () => {
  const live: DiffLiveRead = {
    ok: true,
    text: "live\n",
    mtime: 42,
    source: "worktree",
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
});
