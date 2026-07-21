import { describe, expect, it } from "vite-plus/test";

import { VOLLI_CLI_REFERENCE } from "./skill-content";

describe("VOLLI_CLI_REFERENCE", () => {
  it("reinforces the worktree orientation contract and the read-only worktree commands", () => {
    // Agents must never infer their location: cwd is the worktree, and
    // VOLLI_PROJECT_DIR (the main checkout) is reference-only (worktree-support §8).
    expect(VOLLI_CLI_REFERENCE).toContain("VOLLI_PROJECT_DIR");
    expect(VOLLI_CLI_REFERENCE).toContain("reference-only");
    expect(VOLLI_CLI_REFERENCE).toContain("volli worktree status");
    expect(VOLLI_CLI_REFERENCE).toContain("volli worktree diff");
  });
});
