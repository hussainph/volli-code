import { describe, expect, it } from "vite-plus/test";
import type { ChangeSetFile } from "@volli/shared";

import { diffFilePolicy } from "./diff-file-policy";

function file(overrides: Partial<ChangeSetFile> & Pick<ChangeSetFile, "path">): ChangeSetFile {
  return {
    status: "modified",
    insertions: 1,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

describe("diffFilePolicy", () => {
  it("seeds a modified text file from base content for the editor", () => {
    const policy = diffFilePolicy({
      file: file({ path: "src/a.ts" }),
      base: { content: "console.log(1);\n" },
    });

    expect(policy).toEqual({
      kind: "editor",
      path: "src/a.ts",
      previousPath: null,
      original: { value: "console.log(1);\n", readOnly: true },
      modified: { value: null, readOnly: false },
    });
  });

  it("uses an empty original for added and untracked files", () => {
    for (const status of ["added", "untracked"] as const) {
      expect(
        diffFilePolicy({
          file: file({ path: "src/new.ts", status, insertions: null, deletions: null }),
          base: { missing: true },
        }),
      ).toEqual({
        kind: "editor",
        path: "src/new.ts",
        previousPath: null,
        original: { value: null, readOnly: true },
        modified: { value: null, readOnly: false },
      });
    }
  });

  it("uses an empty read-only modified side for deleted files", () => {
    expect(
      diffFilePolicy({
        file: file({ path: "src/gone.ts", status: "deleted", insertions: 0, deletions: 4 }),
        base: { content: "export const x = 1;\n" },
      }),
    ).toEqual({
      kind: "editor",
      path: "src/gone.ts",
      previousPath: null,
      original: { value: "export const x = 1;\n", readOnly: true },
      modified: { value: null, readOnly: true },
    });
  });

  it("retains previousPath for renames", () => {
    expect(
      diffFilePolicy({
        file: file({
          path: "src/new-name.ts",
          previousPath: "src/old-name.ts",
          status: "renamed",
          insertions: 1,
          deletions: 1,
        }),
        base: { content: "export const old = true;\n" },
      }),
    ).toEqual({
      kind: "editor",
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      original: { value: "export const old = true;\n", readOnly: true },
      modified: { value: null, readOnly: false },
    });
  });

  it("returns a binary stub when the Change Set flag or base read is binary", () => {
    const stub = {
      kind: "binary-stub" as const,
      stubReason: "Binary file",
      path: "assets/logo.png",
      previousPath: null,
      original: { value: null, readOnly: true },
      modified: { value: null, readOnly: true },
    };

    expect(
      diffFilePolicy({
        file: file({
          path: "assets/logo.png",
          binary: true,
          insertions: null,
          deletions: null,
        }),
        base: { content: "not used" },
      }),
    ).toEqual(stub);

    expect(
      diffFilePolicy({
        file: file({ path: "assets/logo.png" }),
        base: { binary: true },
      }),
    ).toEqual(stub);
  });
});
