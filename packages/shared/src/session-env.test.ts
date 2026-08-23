import { describe, expect, it } from "vite-plus/test";

import {
  memoizedPathExists,
  REQUIRABLE_SESSION_ENV_TOOLS,
  requiredSessionEnvTools,
  resolveOnPath,
  resolveSessionEnvTools,
  SESSION_ENV_TOOLS,
  workspaceDependenciesStatus,
  workspaceInstallCommand,
  workspacePackageManager,
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
  // The census is what is MEASURED: identify reports exactly this set and
  // doctor looks up exactly this set. Requiring is the per-project question
  // `requiredSessionEnvTools` answers, and every package manager a lockfile
  // can name has to be measurable for that answer to be reportable.
  it("names every tool a session's PATH is measured for", () => {
    expect(SESSION_ENV_TOOLS).toEqual(["git", "gh", "node", "npm", "pnpm", "yarn", "bun"]);
  });
});

describe("REQUIRABLE_SESSION_ENV_TOOLS", () => {
  // The one name the census measures and no project may require. Asserted
  // rather than assumed: the type keeps a caller from requiring `gh`, and
  // this keeps the list from quietly regrowing it.
  it("is the census minus gh", () => {
    expect(REQUIRABLE_SESSION_ENV_TOOLS).toEqual(SESSION_ENV_TOOLS.filter((tool) => tool !== "gh"));
  });

  // `requiredSessionEnvTools` filters this list, so its order IS census
  // order — the property the report's "same sentence twice" claim rests on.
  it("keeps census order, so requirement lists need no second sort", () => {
    const census = [...SESSION_ENV_TOOLS];
    const positions = REQUIRABLE_SESSION_ENV_TOOLS.map((tool) => census.indexOf(tool));
    expect(positions).toEqual([...positions].toSorted((a, b) => a - b));
  });
});

describe("memoizedPathExists", () => {
  it("asks the filesystem once per path and reuses both answers", () => {
    const asked: string[] = [];
    const exists = memoizedPathExists((path) => {
      asked.push(path);
      return path === "/repo/.git";
    });

    expect(exists("/repo/.git")).toBe(true);
    expect(exists("/repo/.git")).toBe(true);
    expect(exists("/repo/package.json")).toBe(false);
    // A `false` must be remembered too, or the cheap answer is the one that
    // keeps costing: an absent lockfile is asked for by every walk.
    expect(exists("/repo/package.json")).toBe(false);
    expect(asked).toEqual(["/repo/.git", "/repo/package.json"]);
  });

  // The reason it exists: requirements, dependency state and install command
  // walk the same ancestors, and one memo makes that one stat per path.
  it("settles the overlapping workspace walks to one stat per path", () => {
    const asked: string[] = [];
    const present = new Set(["/repo/.git", "/repo/package.json", "/repo/pnpm-lock.yaml"]);
    const exists = memoizedPathExists((path) => {
      asked.push(path);
      return present.has(path);
    });

    requiredSessionEnvTools("/repo", exists);
    workspaceDependenciesStatus("/repo", exists);
    workspaceInstallCommand("/repo", exists);

    expect(asked.length).toBe(new Set(asked).size);
  });

  it("holds nothing across two memos, so a repaired workspace re-reads", () => {
    let present = false;
    const filesystem = (path: string): boolean => present && path === "/repo/.git";

    expect(memoizedPathExists(filesystem)("/repo/.git")).toBe(false);
    present = true;
    expect(memoizedPathExists(filesystem)("/repo/.git")).toBe(true);
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
  it("answers for every measured tool, found or missing", async () => {
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
      npm: null,
      pnpm: null,
      yarn: null,
      bun: null,
    });
  });

  it("reports every tool missing on an empty PATH", async () => {
    expect(await resolveSessionEnvTools([], resolver())).toEqual({
      git: null,
      gh: null,
      node: null,
      npm: null,
      pnpm: null,
      yarn: null,
      bun: null,
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

  // The stray-ancestor case the boundary exists for: a `~/package.json` with
  // a `~/node_modules` (a classic accidental install) must never answer for a
  // worktree that has neither. The `.git` marker is a file in a linked
  // worktree and a directory in a primary checkout; existence is the test
  // either way.
  it("stops at the repository boundary instead of crediting an unrelated ancestor", () => {
    expect(
      workspaceDependenciesStatus(
        "/Users/me/worktrees/wt",
        resolver(
          [],
          [
            "/Users/me/worktrees/wt/package.json",
            "/Users/me/worktrees/wt/.git",
            "/Users/me/package.json",
            "/Users/me/node_modules",
          ],
        ).exists,
      ),
    ).toBe("absent");
  });

  it("still reaches a monorepo root inside the same repository", () => {
    expect(
      workspaceDependenciesStatus(
        "/repo/packages/a",
        resolver(
          [],
          [
            "/repo/packages/a/package.json",
            "/repo/package.json",
            "/repo/node_modules",
            "/repo/.git",
          ],
        ).exists,
      ),
    ).toBe("installed");
  });
});

describe("workspaceInstallCommand", () => {
  it("names the package manager whose lockfile sits at the workspace root", () => {
    expect(
      workspaceInstallCommand(
        "/repo/packages/a",
        resolver(
          [],
          ["/repo/packages/a/package.json", "/repo/package.json", "/repo/pnpm-lock.yaml"],
        ).exists,
      ),
    ).toBe("pnpm install");
  });

  it.each([
    ["yarn.lock", "yarn install"],
    ["package-lock.json", "npm install"],
    ["bun.lock", "bun install"],
    ["bun.lockb", "bun install"],
  ])("maps %s to `%s`", (lockfile, command) => {
    expect(
      workspaceInstallCommand(
        "/work/acme",
        resolver([], ["/work/acme/package.json", `/work/acme/${lockfile}`]).exists,
      ),
    ).toBe(command);
  });

  it("lets the nearest manifest's lockfile win over the root's", () => {
    expect(
      workspaceInstallCommand(
        "/repo/vendored",
        resolver(
          [],
          [
            "/repo/vendored/package.json",
            "/repo/vendored/package-lock.json",
            "/repo/package.json",
            "/repo/pnpm-lock.yaml",
          ],
        ).exists,
      ),
    ).toBe("npm install");
  });

  it("defaults a lockfile-less manifest to npm, the manager every manifest answers to", () => {
    expect(
      workspaceInstallCommand("/work/acme", resolver([], ["/work/acme/package.json"]).exists),
    ).toBe("npm install");
  });

  it("is null when no ancestor is a package workspace", () => {
    expect(workspaceInstallCommand("/home/me", resolver().exists)).toBeNull();
  });

  it("does not read lockfiles past the repository boundary", () => {
    expect(
      workspaceInstallCommand(
        "/repo/wt",
        resolver(
          [],
          ["/repo/wt/package.json", "/repo/wt/.git", "/repo/package.json", "/repo/yarn.lock"],
        ).exists,
      ),
    ).toBe("npm install");
  });
});

describe("workspacePackageManager", () => {
  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lock", "bun"],
    ["bun.lockb", "bun"],
  ])("reads %s as %s", (lockfile, manager) => {
    expect(
      workspacePackageManager(
        "/work/acme",
        resolver([], ["/work/acme/package.json", `/work/acme/${lockfile}`]).exists,
      ),
    ).toBe(manager);
  });

  it("is npm for a manifest no lockfile speaks for", () => {
    expect(
      workspacePackageManager("/work/acme", resolver([], ["/work/acme/package.json"]).exists),
    ).toBe("npm");
  });

  it("is null where no ancestor is a package workspace", () => {
    expect(workspacePackageManager("/home/me", resolver().exists)).toBeNull();
  });
});

// VC-157: the census a project IMPLIES, as opposed to the one Volli's own
// toolchain used to impose on every project it opened.
describe("requiredSessionEnvTools", () => {
  // The repository question reaches the outside only through this answer, so
  // the `.git` marker's own cases are asserted here: found in the directory
  // itself, found up the chain, and absent.
  it("finds the repository marker from a subdirectory of the checkout", () => {
    expect(
      requiredSessionEnvTools("/repo/packages/a", resolver([], ["/repo/.git"]).exists),
    ).toEqual(["git"]);
  });

  // A linked worktree carries `.git` as a FILE, not a directory. Existence is
  // the test, which is what makes a Session's own worktree a repository.
  it("treats a linked worktree's .git file as the marker it is", () => {
    expect(requiredSessionEnvTools("/wt/VC-1", resolver([], ["/wt/VC-1/.git"]).exists)).toEqual([
      "git",
    ]);
  });

  it("requires git, node and the lockfile's manager for a pnpm checkout", () => {
    expect(
      requiredSessionEnvTools(
        "/repo",
        resolver([], ["/repo/.git", "/repo/package.json", "/repo/pnpm-lock.yaml"]).exists,
      ),
    ).toEqual(["git", "node", "pnpm"]);
  });

  // The measured cost this ticket removes: a yarn workspace was told it was
  // missing pnpm, forever, by a product that had already read its lockfile.
  it("never names pnpm for a yarn workspace", () => {
    expect(
      requiredSessionEnvTools(
        "/repo",
        resolver([], ["/repo/.git", "/repo/package.json", "/repo/yarn.lock"]).exists,
      ),
    ).toEqual(["git", "node", "yarn"]);
  });

  it("requires only git for a repository with no JavaScript manifest", () => {
    expect(
      requiredSessionEnvTools("/repo", resolver([], ["/repo/.git", "/repo/pyproject.toml"]).exists),
    ).toEqual(["git"]);
  });

  it("requires node and npm for a package folder that is not a repository", () => {
    expect(
      requiredSessionEnvTools("/scratch/app", resolver([], ["/scratch/app/package.json"]).exists),
    ).toEqual(["node", "npm"]);
  });

  it("requires nothing of a folder that is neither repository nor workspace", () => {
    expect(requiredSessionEnvTools("/Users/me/notes", resolver().exists)).toEqual([]);
  });

  // gh is measured everywhere and required nowhere: its absence is classified
  // at the moment a PR action runs, not on the way in.
  it("never requires gh, whatever the project is", () => {
    expect(
      requiredSessionEnvTools(
        "/repo",
        resolver([], ["/repo/.git", "/repo/package.json", "/repo/pnpm-lock.yaml"]).exists,
      ),
    ).not.toContain("gh");
  });

  // Bun is its own runtime and its own installer. Requiring `node` beside it
  // would fault a bun-only host for a tool the project never runs — the same
  // false fault as pnpm-in-a-yarn-workspace, wearing a different name.
  it("requires bun alone for a bun workspace, never node beside it", () => {
    expect(
      requiredSessionEnvTools(
        "/repo",
        resolver([], ["/repo/.git", "/repo/package.json", "/repo/bun.lock"]).exists,
      ),
    ).toEqual(["git", "bun"]);
  });

  it("reads the legacy binary bun.lockb the same way", () => {
    expect(
      requiredSessionEnvTools(
        "/repo",
        resolver([], ["/repo/package.json", "/repo/bun.lockb"]).exists,
      ),
    ).toEqual(["bun"]);
  });

  it("lists requirements in census order, whatever the manager", () => {
    expect(
      requiredSessionEnvTools(
        "/repo",
        resolver([], ["/repo/.git", "/repo/package.json", "/repo/package-lock.json"]).exists,
      ),
    ).toEqual(["git", "node", "npm"]);
  });
});
