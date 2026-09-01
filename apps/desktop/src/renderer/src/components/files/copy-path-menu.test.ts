import { describe, expect, it, vi } from "vite-plus/test";

import { copyPathEntries, copyPathToClipboard, type CopyPathEntry } from "./copy-path-menu";

describe("copyPathEntries", () => {
  it("offers both spellings once the absolute path is known", () => {
    expect(
      copyPathEntries({ absolutePath: "/worktrees/VC-187/src/app.ts", relPath: "src/app.ts" }),
    ).toEqual([
      { id: "absolute", label: "Copy Path", noun: "path", value: "/worktrees/VC-187/src/app.ts" },
      { id: "relative", label: "Copy Relative Path", noun: "relative path", value: "src/app.ts" },
    ]);
  });

  it("drops Copy Path rather than guessing a checkout root", () => {
    // A guessed absolute path names no file, and the user would find that out
    // in another program — an absent item is the honest state.
    expect(copyPathEntries({ absolutePath: null, relPath: "src/app.ts" })).toEqual([
      { id: "relative", label: "Copy Relative Path", noun: "relative path", value: "src/app.ts" },
    ]);
  });
});

describe("copyPathToClipboard", () => {
  const entry: CopyPathEntry = {
    id: "relative",
    label: "Copy Relative Path",
    noun: "relative path",
    value: "src/app.ts",
  };

  it("writes exactly the entry's own value", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();

    await copyPathToClipboard(entry, { writeText });

    expect(writeText).toHaveBeenCalledWith("src/app.ts");
  });

  it("says so when the clipboard refuses, instead of looking like a copy", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>();
    writeText.mockRejectedValue(new Error("Document is not focused"));

    // The toast is the whole observable outcome; the call must still settle.
    await expect(copyPathToClipboard(entry, { writeText })).resolves.toBeUndefined();
  });

  it("treats a missing clipboard as a refusal rather than throwing", async () => {
    await expect(copyPathToClipboard(entry, undefined)).resolves.toBeUndefined();
  });
});
