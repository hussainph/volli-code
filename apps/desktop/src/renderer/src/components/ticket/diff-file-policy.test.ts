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
});
