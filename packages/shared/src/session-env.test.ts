import { describe, expect, it } from "vite-plus/test";

import {
  resolveOnPath,
  resolveSessionEnvTools,
  SESSION_ENV_TOOLS,
  workspaceDependenciesStatus,
} from "./session-env";
import type { PathResolver } from "./session-env";

/** A scripted filesystem: which paths exist, which of them are executable. */
function resolver(
  executables: readonly string[] = [],
  existing: readonly string[] = [],
): PathResolver & { exists(path: string): boolean } {
  const set = new Set(existing);
  return {
    isExecutable: (path) => Promise.resolve(executables.includes(path)),
    exists: (path) => set.has(path),
  };
}

describe("SESSION_ENV_TOOLS", () => {
  // The census is the contract: identify reports exactly this set and doctor
  // audits exactly this set. A tool added here without a doctor check is a
  // silent gap; the list is deliberately short to keep that coupling real.
  it("names the four tools a session's first commands depend on", () => {
    expect(SESSION_ENV_TOOLS).toEqual(["git", "gh", "node", "pnpm"]);
  });
});

describe("resolveOnPath", () => {
  it("picks the first executable match, exactly as a shell would", async () => {
    expect(await resolveOnPath(["/a", "/b"], "git", resolver(["/a/git", "/b/git"]))).toBe("/a/git");
  });

  it("joins a trailing-slash directory without doubling the separator", async () => {
    expect(await resolveOnPath(["/a/"], "git", resolver(["/a/git"]))).toBe("/a/git");
  });

  it("is null when nothing on PATH is executable", async () => {
    expect(await resolveOnPath(["/a"], "git", resolver())).toBeNull();
  });
});

describe("resolveSessionEnvTools", () => {
  it("answers for every contract tool, found or missing", async () => {
    const tools = await resolveSessionEnvTools(
      ["/usr/bin", "/opt/homebrew/bin"],
      resolver(["/usr/bin/git", "/opt/homebrew/bin/gh", "/opt/homebrew/bin/node"]),
    );
    // The keys are the census and nothing else: pnpm is present-but-null,
    // never absent from the record.
    expect(Object.keys(tools)).toEqual([...SESSION_ENV_TOOLS]);
    expect(tools).toEqual({
      git: "/usr/bin/git",
      gh: "/opt/homebrew/bin/gh",
      node: "/opt/homebrew/bin/node",
      pnpm: null,
    });
  });

  it("reports every tool missing on an empty PATH", async () => {
    expect(await resolveSessionEnvTools([], resolver())).toEqual({
      git: null,
      gh: null,
      node: null,
      pnpm: null,
    });
  });
});

describe("workspaceDependenciesStatus", () => {
  it("is installed when the cwd itself is a manifest with node_modules", () => {
    expect(
      workspaceDependenciesStatus(
        "/work/volli",
        resolver([], ["/work/volli/package.json", "/work/volli/node_modules"]).exists,
      ),
    ).toBe("installed");
  });

  // The pnpm monorepo shape: a session in a package subdirectory must get the
  // workspace root's answer, not a false "absent" from the package's own
  // manifest.
  it("walks up to the workspace root that holds the node_modules", () => {
    expect(
      workspaceDependenciesStatus(
        "/work/volli/apps/desktop",
        resolver(
          [],
          [
            "/work/volli/apps/desktop/package.json",
            "/work/volli/package.json",
            "/work/volli/node_modules",
          ],
        ).exists,
      ),
    ).toBe("installed");
  });

  it("is absent when a manifest exists up the chain but no node_modules does", () => {
    expect(
      workspaceDependenciesStatus(
        "/work/volli/packages/shared",
        resolver([], ["/work/volli/packages/shared/package.json", "/work/volli/package.json"])
          .exists,
      ),
    ).toBe("absent");
  });

  it("is null when no ancestor is a package workspace at all", () => {
    expect(workspaceDependenciesStatus("/home/me", resolver().exists)).toBeNull();
  });

  it("stops the walk at the filesystem root without looping", () => {
    expect(
      workspaceDependenciesStatus("/", resolver([], ["/package.json", "/node_modules"]).exists),
    ).toBe("installed");
  });

  it("handles a trailing slash on the cwd", () => {
    expect(
      workspaceDependenciesStatus(
        "/work/volli/",
        resolver([], ["/work/volli/package.json"]).exists,
      ),
    ).toBe("absent");
  });
});
