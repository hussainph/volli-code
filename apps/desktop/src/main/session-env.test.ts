import { describe, expect, it } from "vite-plus/test";

import { buildSessionEnvReport, executableAt } from "./session-env";

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
      pathExists: (path) => ["/work/volli/package.json", "/work/volli/node_modules"].includes(path),
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
        pnpm: "/opt/homebrew/bin/pnpm",
      },
      dependencies: "installed",
    });
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

describe("executableAt", () => {
  it("agrees with the filesystem about what a shell could run", async () => {
    expect(await executableAt("/definitely/not/a/tool")).toBe(false);
  });
});
