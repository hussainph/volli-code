import { describe, expect, it, vi } from "vite-plus/test";

import { validateHarnessBinary } from "./harness-binary";
import type { BinaryResolverDeps } from "./binary-location";

function deps(overrides: Partial<BinaryResolverDeps> = {}): BinaryResolverDeps {
  return {
    loginShellPath: async () => "/opt/homebrew/bin:/usr/bin:/bin",
    resolveOnPath: async () => "/opt/homebrew/bin/codex",
    isExecutable: async () => true,
    realpath: async (path) => path,
    ...overrides,
  };
}

describe("validateHarnessBinary", () => {
  it("walks a bare name down the login-shell PATH and returns the canonical executable", async () => {
    const resolveOnPath = vi.fn(async (pathValue: string, command: string) => {
      expect(pathValue).toBe("/opt/homebrew/bin:/usr/bin:/bin");
      expect(command).toBe("codex");
      return "/opt/homebrew/bin/codex";
    });
    const realpath = vi.fn(async (path: string) => {
      expect(path).toBe("/opt/homebrew/bin/codex");
      return "/opt/homebrew/Cellar/codex/1.0/bin/codex";
    });

    await expect(
      validateHarnessBinary("codex", deps({ resolveOnPath, realpath })),
    ).resolves.toEqual({ ok: true, resolvedPath: "/opt/homebrew/Cellar/codex/1.0/bin/codex" });
  });

  it("canonicalizes an explicit path instead of walking PATH with it", async () => {
    const resolveOnPath = vi.fn(async () => null);

    await expect(
      validateHarnessBinary(
        "/opt/custom/codex",
        deps({ resolveOnPath, realpath: async () => "/opt/custom/codex-1.0" }),
      ),
    ).resolves.toEqual({ ok: true, resolvedPath: "/opt/custom/codex-1.0" });
    expect(resolveOnPath).not.toHaveBeenCalled();
  });

  it("reports a login shell that could not answer as path-unavailable, distinct from a genuine miss", async () => {
    await expect(
      validateHarnessBinary("codex", deps({ loginShellPath: async () => null })),
    ).resolves.toEqual({
      ok: false,
      reason: "path-unavailable",
      error: "Could not read the login-shell PATH to find codex",
    });
  });

  it("reports a bare command on no PATH entry as not-found", async () => {
    await expect(
      validateHarnessBinary("codex", deps({ resolveOnPath: async () => null })),
    ).resolves.toEqual({
      ok: false,
      reason: "not-found",
      error: "codex was not found on the login-shell PATH",
    });
  });

  it("reports a configured path that is not executable", async () => {
    await expect(
      validateHarnessBinary("/opt/custom/codex", deps({ isExecutable: async () => false })),
    ).resolves.toEqual({
      ok: false,
      reason: "not-executable",
      error: "/opt/custom/codex is not an executable file",
    });
  });

  it("reports a winning candidate that could not be canonicalized", async () => {
    await expect(
      validateHarnessBinary(
        "/opt/custom/codex",
        deps({
          realpath: async () => {
            throw new Error("ELOOP: too many symbolic links");
          },
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "not-resolvable",
      error: "ELOOP: too many symbolic links",
    });
  });
});
