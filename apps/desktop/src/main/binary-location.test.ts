import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  isExecutable,
  locateBinary,
  verifiedPath,
  type BinaryResolverDeps,
} from "./binary-location";

function deps(overrides: Partial<BinaryResolverDeps> = {}): BinaryResolverDeps {
  return {
    loginShellPath: async () => "/opt/homebrew/bin:/usr/bin:/bin",
    resolveOnPath: async () => "/opt/homebrew/bin/codex",
    isExecutable: async () => true,
    realpath: async (path) => path,
    ...overrides,
  };
}

describe("locateBinary", () => {
  it("walks a bare name down the login-shell PATH", async () => {
    const resolveOnPath = vi.fn(async (pathValue: string, command: string) => {
      expect(pathValue).toBe("/opt/homebrew/bin:/usr/bin:/bin");
      expect(command).toBe("codex");
      return "/opt/homebrew/bin/codex";
    });

    await expect(locateBinary("codex", deps({ resolveOnPath }))).resolves.toEqual({
      ok: true,
      path: "/opt/homebrew/bin/codex",
    });
    expect(resolveOnPath).toHaveBeenCalledOnce();
  });

  it("reports a login shell that could not answer", async () => {
    await expect(
      locateBinary("codex", deps({ loginShellPath: async () => null })),
    ).resolves.toEqual({ ok: false, reason: "path-unreadable" });
  });

  it("reports a bare command that is on no PATH entry", async () => {
    await expect(locateBinary("codex", deps({ resolveOnPath: async () => null }))).resolves.toEqual(
      {
        ok: false,
        reason: "not-on-path",
      },
    );
  });

  it("takes an absolute path at its word instead of walking PATH with it", async () => {
    const loginShellPath = vi.fn(async () => "/opt/homebrew/bin:/usr/bin:/bin");
    const resolveOnPath = vi.fn(async () => "/usr/bin/opt/custom/codex");
    const isExecutableSpy = vi.fn(async () => true);

    await expect(
      locateBinary(
        "/opt/custom/codex",
        deps({ loginShellPath, resolveOnPath, isExecutable: isExecutableSpy }),
      ),
    ).resolves.toEqual({ ok: true, path: "/opt/custom/codex" });

    expect(isExecutableSpy).toHaveBeenCalledWith("/opt/custom/codex");
    expect(resolveOnPath).not.toHaveBeenCalled();
    expect(loginShellPath).not.toHaveBeenCalled();
  });

  it("treats any value carrying a separator as a path", async () => {
    const resolveOnPath = vi.fn(async () => null);

    await expect(locateBinary("bin/codex", deps({ resolveOnPath }))).resolves.toEqual({
      ok: true,
      path: "bin/codex",
    });
    expect(resolveOnPath).not.toHaveBeenCalled();
  });
});

describe("isExecutable", () => {
  it("is true for a file the process can execute", async () => {
    await expect(isExecutable(process.execPath)).resolves.toBe(true);
  });

  it("is false for a path with nothing there", async () => {
    await expect(isExecutable("/nonexistent/definitely-not-a-binary")).resolves.toBe(false);
  });

  // A directory carries +x (that is what "searchable" means for one), so the
  // X_OK probe alone says yes to `/opt/homebrew/bin` — and a saved override
  // naming a directory only fails much later, as a spawn EACCES.
  it("is false for a directory, which carries the execute bit but cannot be run", async () => {
    await expect(isExecutable(dirname(process.execPath))).resolves.toBe(false);
  });

  it("is false for a regular file with no execute bit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-binary-location-"));
    const script = join(dir, "not-executable");
    await writeFile(script, "#!/bin/sh\necho hi\n", { mode: 0o644 });
    try {
      await expect(isExecutable(script)).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
