import { describe, expect, it, vi } from "vite-plus/test";

import {
  isExecutable,
  resolveOpenCodeBinary,
  verifiedPath,
  type OpenCodeBinaryResolverDeps,
} from "./opencode-binary";

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
  it("walks a bare name down the login-shell PATH and returns the canonical executable", async () => {
    const resolveOnPath = vi.fn(async (pathValue: string, command: string) => {
      expect(pathValue).toBe("/opt/homebrew/bin:/usr/bin:/bin");
      expect(command).toBe("opencode");
      return "/opt/homebrew/bin/opencode";
    });
    const realpath = vi.fn(async (path: string) => {
      expect(path).toBe("/opt/homebrew/bin/opencode");
      return "/opt/homebrew/Cellar/opencode/1.0/bin/opencode";
    });

    await expect(
      resolveOpenCodeBinary("opencode", deps({ resolveOnPath, realpath })),
    ).resolves.toBe("/opt/homebrew/Cellar/opencode/1.0/bin/opencode");

    expect(resolveOnPath).toHaveBeenCalledOnce();
    expect(realpath).toHaveBeenCalledOnce();
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
    const isExecutableSpy = vi.fn(async () => true);

    await expect(
      resolveOpenCodeBinary(
        "/opt/custom/opencode",
        deps({
          loginShellPath,
          resolveOnPath,
          isExecutable: isExecutableSpy,
          realpath: async () => "/opt/custom/opencode-1.0",
        }),
      ),
    ).resolves.toBe("/opt/custom/opencode-1.0");

    expect(isExecutableSpy).toHaveBeenCalledWith("/opt/custom/opencode");
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

describe("isExecutable", () => {
  it("is true for a file the process can execute", async () => {
    await expect(isExecutable(process.execPath)).resolves.toBe(true);
  });

  it("is false for a path with nothing there", async () => {
    await expect(isExecutable("/nonexistent/definitely-not-a-binary")).resolves.toBe(false);
  });
});

describe("verifiedPath", () => {
  it("locates a command already at its word", async () => {
    await expect(verifiedPath("/opt/custom/codex", deps())).resolves.toEqual({
      ok: true,
      path: "/opt/custom/codex",
    });
  });

  it("refuses one that is not executable", async () => {
    await expect(
      verifiedPath("/opt/custom/codex", deps({ isExecutable: async () => false })),
    ).resolves.toEqual({
      ok: false,
      reason: "not-executable",
    });
  });
});
