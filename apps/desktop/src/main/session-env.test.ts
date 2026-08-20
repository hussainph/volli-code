import { describe, expect, it } from "vite-plus/test";

import { buildSessionEnvReport, executableAt } from "./session-env";

describe("buildSessionEnvReport", () => {
  it("reports the PATH, provenance, tool verdicts and dependency state together", async () => {
    const report = await buildSessionEnvReport({
      path: "/profile/bin:/opt/homebrew/bin:/usr/bin",
      provenance: "adopted",
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
      cwd: "/work/volli",
      isExecutable: async () => false,
      pathExists: () => false,
    });
    expect(report.provenance).toBe("probe-failed");
    expect(report.dependencies).toBeNull();
  });

  it("drops empty PATH entries before resolving, like every other PATH consumer", async () => {
    const seen: string[] = [];
    await buildSessionEnvReport({
      path: ":/opt/homebrew/bin:",
      provenance: "already-complete",
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
