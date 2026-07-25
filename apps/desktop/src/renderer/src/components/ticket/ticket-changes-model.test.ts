import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetFile } from "@volli/shared";

import { formatChangeCounts, formatChangeStatus, splitChangePath } from "./ticket-changes-model";

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
