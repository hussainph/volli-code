import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetFile } from "@volli/shared";

import {
  formatChangeCounts,
  formatChangeStatus,
  presentChangeRow,
  sortChangeSetFiles,
  splitChangePath,
} from "./ticket-changes-model";

function file(overrides: Partial<ChangeSetFile> & Pick<ChangeSetFile, "path">): ChangeSetFile {
  return {
    status: "modified",
    insertions: 1,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

describe("splitChangePath", () => {
  it("leads with the filename and keeps the parent path secondary", () => {
    expect(splitChangePath("src/components/ticket/rail.tsx")).toEqual({
      filename: "rail.tsx",
      parentPath: "src/components/ticket",
    });
  });

  it("uses an empty parent for repo-root files", () => {
    expect(splitChangePath("README.md")).toEqual({ filename: "README.md", parentPath: "" });
  });
});

describe("formatChangeStatus", () => {
  it("labels every Change Set status including conflicted", () => {
    expect(formatChangeStatus("added")).toBe("Added");
    expect(formatChangeStatus("modified")).toBe("Modified");
    expect(formatChangeStatus("deleted")).toBe("Deleted");
    expect(formatChangeStatus("renamed")).toBe("Renamed");
    expect(formatChangeStatus("untracked")).toBe("Untracked");
    expect(formatChangeStatus("conflicted")).toBe("Conflicted");
  });
});

describe("formatChangeCounts", () => {
  it("renders insertion and deletion counts for text files", () => {
    expect(formatChangeCounts(file({ path: "a.ts", insertions: 11, deletions: 2 }))).toBe("+11 −2");
  });

  it("shows an honest binary marker instead of +0 −0", () => {
    expect(
      formatChangeCounts(
        file({ path: "logo.png", insertions: null, deletions: null, binary: true }),
      ),
    ).toBe("Binary");
  });

  it("shows no counts when both sides are null on a non-binary (e.g. untracked)", () => {
    expect(
      formatChangeCounts(
        file({
          path: "scratch.txt",
          status: "untracked",
          insertions: null,
          deletions: null,
          binary: false,
        }),
      ),
    ).toBeNull();
  });
});

describe("presentChangeRow", () => {
  it("presents a normal file with filename, parent, status, and counts", () => {
    expect(presentChangeRow(file({ path: "src/a.ts", insertions: 3, deletions: 1 }))).toEqual({
      path: "src/a.ts",
      filename: "a.ts",
      parentPath: "src",
      statusLabel: "Modified",
      countsLabel: "+3 −1",
      renameFrom: null,
    });
  });

  it("surfaces both rename paths (previousPath → path)", () => {
    expect(
      presentChangeRow(
        file({
          path: "src/new-name.ts",
          previousPath: "src/old-name.ts",
          status: "renamed",
          insertions: 0,
          deletions: 0,
        }),
      ),
    ).toEqual({
      path: "src/new-name.ts",
      filename: "new-name.ts",
      parentPath: "src",
      statusLabel: "Renamed",
      countsLabel: "+0 −0",
      renameFrom: "src/old-name.ts",
    });
  });
});

describe("sortChangeSetFiles", () => {
  it("sorts by path for a stable flat list", () => {
    const sorted = sortChangeSetFiles([
      file({ path: "z.ts" }),
      file({ path: "a/b.ts" }),
      file({ path: "a.ts" }),
    ]);
    expect(sorted.map((f) => f.path)).toEqual(["a.ts", "a/b.ts", "z.ts"]);
  });
});
