import { describe, expect, it, vi } from "vite-plus/test";

import { resolveOpenCodeBinary } from "./opencode-binary";

describe("resolveOpenCodeBinary", () => {
  it("uses the login-shell PATH over a Finder-like process PATH and returns an absolute executable", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    const resolveOnPath = vi.fn(async (pathValue: string, command: string) => {
      expect(pathValue).toBe("/opt/homebrew/bin:/usr/bin:/bin");
      expect(command).toBe("opencode");
      return "/opt/homebrew/bin/opencode";
    });
    const realpath = vi.fn(async (path: string) => {
      expect(path).toBe("/opt/homebrew/bin/opencode");
      return "/opt/homebrew/Cellar/opencode/1.0/bin/opencode";
    });

    try {
      await expect(
        resolveOpenCodeBinary("opencode", {
          loginShellPath: async () => "/opt/homebrew/bin:/usr/bin:/bin",
          resolveOnPath,
          realpath,
        }),
      ).resolves.toBe("/opt/homebrew/Cellar/opencode/1.0/bin/opencode");

      expect(process.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
      expect(resolveOnPath).toHaveBeenCalledOnce();
      expect(realpath).toHaveBeenCalledOnce();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});
