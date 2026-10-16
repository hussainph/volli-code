import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openTestDb } from "./db/test-helpers";
import { runGitCapturing, runGitCapturingAsync } from "./worktree/git";
import {
  createWorktreeRuntime,
  orphanCleanupEngine,
  worktreeHomeDir,
  worktreesHome,
} from "./worktree-runtime";

afterEach(() => vi.unstubAllEnvs());

describe("host-owned worktree dependencies", () => {
  it("uses the host's data directory and event port, with the unchanged git runners", () => {
    const ctx = openTestDb();
    try {
      vi.stubEnv("VOLLI_WORKTREE_HOME_DIR", "/test-home");
      const publish = vi.fn();
      const runtime = createWorktreeRuntime({ events: { publish } }, { dataDir: "/host-data" });
      const deps = runtime.deps(ctx.db);
      expect(deps.db).toBe(ctx.db);
      expect(deps.git).toBe(runGitCapturing);
      expect(deps.gitAsync).toBe(runGitCapturingAsync);
      expect(deps.home).toBe("/test-home");
      expect(deps.blobsRoot).toBe(join("/host-data", "blobs"));
      deps.onPhase?.("t", "ready");
      expect(publish).toHaveBeenCalledExactlyOnceWith("worktree-phase", {
        ticketId: "t",
        phase: "ready",
      });
      expect(worktreeHomeDir()).toBe("/test-home");
      expect(worktreesHome()).toBe(join("/test-home", ".volli", "worktrees"));
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps the home fallback for absent and empty overrides", () => {
    vi.stubEnv("VOLLI_WORKTREE_HOME_DIR", undefined);
    expect(worktreeHomeDir()).toBe(homedir());
    vi.stubEnv("VOLLI_WORKTREE_HOME_DIR", "");
    expect(worktreeHomeDir()).toBe(homedir());
  });

  it("keeps one cleanup engine per database handle", () => {
    const first = openTestDb();
    const second = openTestDb();
    try {
      expect(orphanCleanupEngine(first.db)).toBe(orphanCleanupEngine(first.db));
      expect(orphanCleanupEngine(second.db)).not.toBe(orphanCleanupEngine(first.db));
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});
