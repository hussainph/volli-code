import { describe, expect, it, vi } from "vite-plus/test";

import { overwriteAutosaveConflict } from "./file-view";

describe("overwriteAutosaveConflict", () => {
  it("writes the exact retained draft against the newer disk revision", async () => {
    const write = vi.fn().mockResolvedValue({ ok: true, mtime: 31 });

    const result = await overwriteAutosaveConflict({
      draft: "exact human draft\n",
      diskRevision: 29,
      write,
    });

    expect(write).toHaveBeenCalledWith({
      content: "exact human draft\n",
      expectedMtime: 29,
    });
    expect(result).toEqual({ ok: true, mtime: 31 });
  });
});
