import { describe, expect, it, vi } from "vite-plus/test";

import { resolveOpenCodeBinary, type OpenCodeBinaryResolverDeps } from "./opencode-binary";

function deps(overrides: Partial<OpenCodeBinaryResolverDeps> = {}): OpenCodeBinaryResolverDeps {
  return {
    loginShellPath: async () => "/opt/homebrew/bin:/usr/bin:/bin",
    resolveOnPath: async () => "/opt/homebrew/bin/opencode",
    isExecutable: async () => true,
    realpath: async (path) => path,
    ...overrides,
  };
}

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
        resolveOpenCodeBinary("opencode", deps({ resolveOnPath, realpath })),
      ).resolves.toBe("/opt/homebrew/Cellar/opencode/1.0/bin/opencode");

      expect(process.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
      expect(resolveOnPath).toHaveBeenCalledOnce();
      expect(realpath).toHaveBeenCalledOnce();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("reports a login shell that could not answer", async () => {
    await expect(
      resolveOpenCodeBinary("opencode", deps({ loginShellPath: async () => null })),
    ).rejects.toThrow("Could not read the login-shell PATH to find OpenCode");
  });

  it("reports a bare command that is on no PATH entry", async () => {
    await expect(
      resolveOpenCodeBinary("opencode", deps({ resolveOnPath: async () => null })),
    ).rejects.toThrow("OpenCode executable opencode was not found on the login-shell PATH");
  });

  it("canonicalizes a configured path instead of walking PATH with it", async () => {
    const loginShellPath = vi.fn(async () => "/opt/homebrew/bin:/usr/bin:/bin");
    const resolveOnPath = vi.fn(async () => "/usr/bin/opt/custom/opencode");
    const isExecutable = vi.fn(async () => true);

    await expect(
      resolveOpenCodeBinary(
        "/opt/custom/opencode",
        deps({
          loginShellPath,
          resolveOnPath,
          isExecutable,
          realpath: async () => "/opt/custom/opencode-1.0",
        }),
      ),
    ).resolves.toBe("/opt/custom/opencode-1.0");

    expect(isExecutable).toHaveBeenCalledWith("/opt/custom/opencode");
    expect(resolveOnPath).not.toHaveBeenCalled();
    expect(loginShellPath).not.toHaveBeenCalled();
  });

  it("treats any value carrying a separator as a path", async () => {
    const resolveOnPath = vi.fn(async () => null);

    await expect(resolveOpenCodeBinary("bin/opencode", deps({ resolveOnPath }))).resolves.toBe(
      "bin/opencode",
    );
    expect(resolveOnPath).not.toHaveBeenCalled();
  });

  it("rejects a configured path that is not executable", async () => {
    await expect(
      resolveOpenCodeBinary("/opt/custom/opencode", deps({ isExecutable: async () => false })),
    ).rejects.toThrow("OpenCode executable /opt/custom/opencode is not an executable file");
  });
});
