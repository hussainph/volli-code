import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { buildSessionEnvReport, executableAt, readWorkspaceEnvironment } from "./session-env";

describe("buildSessionEnvReport", () => {
  it("reports the PATH, provenance, tool verdicts and dependency state together", async () => {
    const report = await buildSessionEnvReport({
      path: "/profile/bin:/opt/homebrew/bin:/usr/bin",
      provenance: "adopted",
      interactiveProvenance: "already-complete",
      cwd: "/work/volli",
      isExecutable: (path) =>
        Promise.resolve(
          ["/opt/homebrew/bin/gh", "/opt/homebrew/bin/node", "/opt/homebrew/bin/pnpm"].includes(
            path,
          ),
        ),
      pathExists: (path) =>
        [
          "/work/volli/package.json",
          "/work/volli/node_modules",
          "/work/volli/pnpm-lock.yaml",
          "/work/volli/.git",
        ].includes(path),
    });

    expect(report).toEqual({
      path: "/profile/bin:/opt/homebrew/bin:/usr/bin",
      provenance: "adopted",
      interactiveProvenance: "already-complete",
      // git is absent from the scripted filesystem: reported as measured-null,
      // not dropped from the census.
      tools: {
        git: null,
        gh: "/opt/homebrew/bin/gh",
        node: "/opt/homebrew/bin/node",
        npm: null,
        pnpm: "/opt/homebrew/bin/pnpm",
        yarn: null,
        bun: null,
      },
      // The workspace's own implication: a git checkout with a pnpm
      // lockfile. `gh` is measured beside these and required by none, so its
      // presence or absence is a report rather than a fault (VC-157).
      requiredTools: ["git", "node", "pnpm"],
      dependencies: "installed",
    });
  });

  // The report is scoped to a project or to nothing at all; a host-wide read
  // has no workspace to imply a tool, so it implies none.
  it("requires nothing when a host-wide read has no workspace in scope", async () => {
    const report = await buildSessionEnvReport({
      path: "/usr/bin",
      provenance: "already-complete",
      interactiveProvenance: "already-complete",
      isExecutable: async () => false,
      pathExists: () => {
        throw new Error("a host-wide read must not inspect an arbitrary workspace");
      },
    });

    expect(report.requiredTools).toEqual([]);
  });

  it("requires only git of a repository with no JavaScript manifest", async () => {
    const report = await buildSessionEnvReport({
      path: "/usr/bin",
      provenance: "adopted",
      interactiveProvenance: "adopted",
      cwd: "/work/py",
      isExecutable: async () => false,
      pathExists: (path) => path === "/work/py/.git",
    });

    expect(report.requiredTools).toEqual(["git"]);
  });

  it("passes the provenance through untouched — it is main's boot fact, not a re-measurement", async () => {
    const report = await buildSessionEnvReport({
      path: "/usr/bin:/bin",
      provenance: "probe-failed",
      interactiveProvenance: "pending",
      cwd: "/work/volli",
      isExecutable: async () => false,
      pathExists: () => false,
    });
    expect(report.provenance).toBe("probe-failed");
    expect(report.dependencies).toBeNull();
  });

  // The two passes are independent facts, and their cross-product is real: a
  // boot probe that failed and an interactive pass that then succeeded is an
  // ordinary recovered host. A single provenance word could not say it.
  it("reports the two adoption passes separately rather than collapsing them", async () => {
    const report = await buildSessionEnvReport({
      path: "/profile/bin:/Users/x/.bun/bin:/usr/bin",
      provenance: "probe-failed",
      interactiveProvenance: "adopted",
      cwd: "/work/volli",
      isExecutable: async () => false,
      pathExists: () => false,
    });
    expect(report.provenance).toBe("probe-failed");
    expect(report.interactiveProvenance).toBe("adopted");
  });

  // `pending` is the one answer only the second pass can give, and the whole
  // reason identify reads it rather than awaiting it.
  it("reports a second pass that has not landed as pending, not as a failure", async () => {
    const report = await buildSessionEnvReport({
      path: "/profile/bin:/usr/bin",
      provenance: "adopted",
      interactiveProvenance: "pending",
      cwd: "/work/volli",
      isExecutable: async () => false,
      pathExists: () => false,
    });
    expect(report.interactiveProvenance).toBe("pending");
  });

  it("does not infer dependency state when a host-wide read has no workspace", async () => {
    const report = await buildSessionEnvReport({
      path: "/usr/bin",
      provenance: "already-complete",
      interactiveProvenance: "already-complete",
      isExecutable: async () => false,
      pathExists: () => {
        throw new Error("a host-wide read must not inspect an arbitrary workspace");
      },
    });

    expect(report.dependencies).toBeNull();
  });

  it("drops empty PATH entries before resolving, like every other PATH consumer", async () => {
    const seen: string[] = [];
    await buildSessionEnvReport({
      path: ":/opt/homebrew/bin:",
      provenance: "already-complete",
      interactiveProvenance: "already-complete",
      cwd: "/",
      isExecutable: (path) => {
        seen.push(path);
        return Promise.resolve(false);
      },
      pathExists: () => false,
    });
    expect(seen).not.toContain("");
    expect(seen).not.toContain("/git");
  });
});

// The pair a structured Session's prompt carries (VC-156): the state and the
// command that changes it, measured together so the agent never has to guess.
describe("readWorkspaceEnvironment", () => {
  it("names the absent state and the workspace's own install command together", () => {
    expect(
      readWorkspaceEnvironment("/work/harbor", (path) =>
        ["/work/harbor/.git", "/work/harbor/package.json", "/work/harbor/yarn.lock"].includes(path),
      ),
    ).toEqual({ dependencies: "absent", installCommand: "yarn install" });
  });

  it("reports an installed workspace, and a directory that is no workspace at all", () => {
    expect(
      readWorkspaceEnvironment("/work/harbor", (path) =>
        [
          "/work/harbor/.git",
          "/work/harbor/package.json",
          "/work/harbor/pnpm-lock.yaml",
          "/work/harbor/node_modules",
        ].includes(path),
      ),
    ).toEqual({ dependencies: "installed", installCommand: "pnpm install" });

    expect(readWorkspaceEnvironment("/work/notes", (path) => path === "/work/notes/.git")).toEqual({
      dependencies: null,
      installCommand: null,
    });
  });

  it("reads the real filesystem when no seam is supplied", () => {
    expect(readWorkspaceEnvironment("/definitely/not/a/workspace")).toEqual({
      dependencies: null,
      installCommand: null,
    });
  });
});

describe("executableAt", () => {
  it("agrees with the filesystem about what a shell could run", async () => {
    expect(await executableAt("/definitely/not/a/tool")).toBe(false);
  });

  // access(X_OK) alone passes for a directory; a shell requires a regular
  // file, so a directory named after a tool must not be reported as one.
  it("refuses a directory and accepts an executable regular file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-session-env-"));
    try {
      const toolShapedDir = join(dir, "git");
      await mkdir(toolShapedDir, { recursive: true });
      const runnable = join(dir, "gh");
      await writeFile(runnable, "#!/bin/sh\n", { mode: 0o755 });

      expect(await executableAt(toolShapedDir)).toBe(false);
      expect(await executableAt(runnable)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
