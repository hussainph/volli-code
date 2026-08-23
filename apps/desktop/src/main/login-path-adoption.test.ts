import { describe, expect, it } from "vite-plus/test";

import {
  BARE_LAUNCHD_PATH,
  createLoginPathBootstrap,
  currentPathIsIncomplete,
  decideLoginPathAdoption,
  interactivePathLogLine,
  loginPathLogLine,
} from "./login-path-adoption";

/** A bootstrap whose interactive pass is never asked for, for the boot-only cases. */
const noInteractiveProbe = async (): Promise<string | null> => null;

describe("currentPathIsIncomplete", () => {
  it("is true for launchd's exact bare set", () => {
    expect(currentPathIsIncomplete(BARE_LAUNCHD_PATH, "/opt/homebrew/bin:/usr/bin")).toBe(true);
  });

  it("is true when the current PATH is missing", () => {
    expect(currentPathIsIncomplete(undefined, "/opt/homebrew/bin")).toBe(true);
  });

  it("is true when the current PATH lacks an entry the login shell has", () => {
    expect(currentPathIsIncomplete("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin:/bin")).toBe(true);
  });

  it("is false when the current PATH already holds every entry the login shell has", () => {
    // A dev boot's PATH: rich, script-local dirs the login shell knows nothing
    // about, but not missing anything the login shell would add.
    expect(
      currentPathIsIncomplete(
        "/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin",
        "/opt/homebrew/bin:/usr/bin",
      ),
    ).toBe(false);
  });

  it("is false when the two paths hold the same entries in a different order", () => {
    expect(
      currentPathIsIncomplete("/usr/bin:/opt/homebrew/bin", "/opt/homebrew/bin:/usr/bin"),
    ).toBe(false);
  });
});

describe("decideLoginPathAdoption", () => {
  it("reports the probe failure when the login shell could not answer", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, null)).toEqual({ kind: "probe-failed" });
  });

  it("reports the probe failure when the login shell answered with nothing", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, "")).toEqual({ kind: "probe-failed" });
  });

  it("unions a login PATH ahead of what launchd handed the app", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, "/opt/homebrew/bin:/usr/bin:/bin")).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      entryCount: 5,
      added: ["/opt/homebrew/bin"],
    });
  });

  // "Kept because nothing changed" and "kept because the probe failed" used
  // to be one outcome and one log line, which is how adoption failure hid in
  // plain sight as health.
  it("distinguishes an already-complete PATH from a failed probe", () => {
    expect(decideLoginPathAdoption(BARE_LAUNCHD_PATH, BARE_LAUNCHD_PATH)).toEqual({
      kind: "already-complete",
    });
  });

  it("puts a login shell's directories ahead of a dev boot without dropping its private bin", () => {
    const rich = "/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin";
    expect(decideLoginPathAdoption(rich, "/opt/homebrew/bin:/usr/bin")).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin:/usr/bin:/repo/node_modules/.bin",
      entryCount: 3,
      added: [],
    });
  });

  it("deduplicates repeated directories while preserving login then current order", () => {
    expect(
      decideLoginPathAdoption(
        "/repo/node_modules/.bin:/usr/bin:/repo/node_modules/.bin",
        "/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin",
      ),
    ).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin:/usr/bin:/repo/node_modules/.bin",
      entryCount: 3,
      added: ["/opt/homebrew/bin"],
    });
  });

  it("adopts when the current PATH is entirely unset", () => {
    expect(decideLoginPathAdoption(undefined, "/opt/homebrew/bin")).toEqual({
      kind: "adopted",
      path: "/opt/homebrew/bin",
      entryCount: 1,
      added: ["/opt/homebrew/bin"],
    });
  });
});

describe("loginPathLogLine", () => {
  it("names the entry count on adoption", () => {
    expect(
      loginPathLogLine({
        kind: "adopted",
        path: "/opt/homebrew/bin:/usr/bin",
        entryCount: 2,
        added: ["/opt/homebrew/bin", "/usr/bin"],
      }),
    ).toBe("[volli] PATH adopted from login shell (2 entries)");
  });

  it("says the healthy kept reason when the PATH was already complete", () => {
    expect(loginPathLogLine({ kind: "already-complete" })).toBe(
      "[volli] PATH kept (already complete)",
    );
  });

  it("names the probe failure instead of reading like health", () => {
    expect(loginPathLogLine({ kind: "probe-failed" })).toBe(
      "[volli] PATH kept (login shell probe failed)",
    );
  });
});

describe("createLoginPathBootstrap", () => {
  it("starts probing immediately but shares one deferred apply", async () => {
    let resolveProbe: ((path: string | null) => void) | undefined;
    let probeCount = 0;
    const mutations: string[] = [];
    const logs: string[] = [];
    const bootstrap = createLoginPathBootstrap({
      binDir: "/profile/bin",
      readCurrentPath: () => BARE_LAUNCHD_PATH,
      writePath: (path) => mutations.push(path),
      resolveLoginPath: () => {
        probeCount += 1;
        return new Promise((resolve) => {
          resolveProbe = resolve;
        });
      },
      resolveInteractiveLoginPath: noInteractiveProbe,
      log: (line) => logs.push(line),
    });

    expect(probeCount).toBe(1);
    expect(mutations).toEqual([]);
    expect(logs).toEqual([]);

    const firstApply = bootstrap.apply();
    const secondApply = bootstrap.apply();
    expect(secondApply).toBe(firstApply);

    resolveProbe?.("/opt/homebrew/bin:/usr/bin:/bin");
    await firstApply;

    expect(mutations).toEqual(["/profile/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"]);
    expect(logs).toEqual(["[volli] PATH adopted from login shell (5 entries)"]);
  });

  it("keeps a failed probe while deduplicating and re-prepending the profile bin", async () => {
    const mutations: string[] = [];
    const logs: string[] = [];
    const bootstrap = createLoginPathBootstrap({
      binDir: "/profile/bin",
      readCurrentPath: () => "/usr/bin:/profile/bin:/bin:/profile/bin",
      writePath: (path) => mutations.push(path),
      resolveLoginPath: async () => Promise.reject(new Error("profile failed")),
      resolveInteractiveLoginPath: noInteractiveProbe,
      log: (line) => logs.push(line),
    });

    await expect(bootstrap.apply()).resolves.toEqual({ kind: "probe-failed" });
    await bootstrap.apply();

    expect(mutations).toEqual(["/profile/bin:/usr/bin:/bin"]);
    expect(logs).toEqual(["[volli] PATH kept (login shell probe failed)"]);
  });

  it("reports an already-complete PATH without pretending the probe failed", async () => {
    const mutations: string[] = [];
    const logs: string[] = [];
    const bootstrap = createLoginPathBootstrap({
      binDir: "/profile/bin",
      // The login shell's own PATH, already leading: merging changes nothing,
      // which is the healthy dev-boot answer — not a probe failure.
      readCurrentPath: () => "/opt/homebrew/bin:/profile/bin",
      writePath: (path) => mutations.push(path),
      resolveLoginPath: async () => "/opt/homebrew/bin",
      resolveInteractiveLoginPath: noInteractiveProbe,
      log: (line) => logs.push(line),
    });

    await expect(bootstrap.apply()).resolves.toEqual({ kind: "already-complete" });
    expect(mutations).toEqual(["/profile/bin:/opt/homebrew/bin"]);
    expect(logs).toEqual(["[volli] PATH kept (already complete)"]);
  });
});

describe("interactivePathLogLine", () => {
  it("names the directories the interactive shell added, not just how many", () => {
    expect(
      interactivePathLogLine({
        kind: "adopted",
        path: "/profile/bin:/Users/x/.bun/bin:/usr/bin",
        added: ["/Users/x/.bun/bin"],
      }),
    ).toBe("[volli] PATH extended by interactive login shell (+1: /Users/x/.bun/bin)");
  });

  it("says reordered rather than claiming an addition it did not make", () => {
    expect(interactivePathLogLine({ kind: "adopted", path: "/a:/b", added: [] })).toBe(
      "[volli] PATH reordered by interactive login shell",
    );
  });

  it("distinguishes an interactive shell that adds nothing from one that could not be asked", () => {
    expect(interactivePathLogLine({ kind: "already-complete" })).toBe(
      "[volli] PATH kept (interactive login shell adds nothing)",
    );
    expect(interactivePathLogLine({ kind: "probe-failed" })).toBe(
      "[volli] PATH kept (interactive login shell probe failed)",
    );
  });
});

/**
 * A bootstrap over a scripted pair of shells, tracking every PATH it installs.
 * `currentPath` reads back what was last written, which is what the second pass
 * merges onto — the two passes share one live PATH, not two snapshots.
 */
const scriptedBootstrap = (options: {
  loginPath: string | null;
  interactivePath: () => Promise<string | null>;
}): {
  bootstrap: ReturnType<typeof createLoginPathBootstrap>;
  mutations: string[];
  logs: string[];
  currentPath: () => string;
} => {
  const mutations: string[] = [];
  const logs: string[] = [];
  let currentPath = BARE_LAUNCHD_PATH;
  const bootstrap = createLoginPathBootstrap({
    binDir: "/profile/bin",
    readCurrentPath: () => currentPath,
    writePath: (path) => {
      currentPath = path;
      mutations.push(path);
    },
    resolveLoginPath: async () => options.loginPath,
    resolveInteractiveLoginPath: options.interactivePath,
    log: (line) => logs.push(line),
  });
  return { bootstrap, mutations, logs, currentPath: () => currentPath };
};

/**
 * The second pass (VC-94's A3). The boot probe is non-interactive, so zsh never
 * reads `.zshrc`; these cases are the partial failure that leaves behind — a
 * successful adoption that is still missing the toolchain directories nvm, bun,
 * rbenv, pyenv and mise conventionally export from there.
 */
describe("createLoginPathBootstrap: the interactive pass", () => {
  /** The seven directories measured missing on the reporting host under `-l` but present under `-l -i`. */
  const ZSHRC_DIRECTORIES = [
    "/Users/x/.bun/bin",
    "/Users/x/.opencode/bin",
    "/Users/x/.fly/bin",
    "/Users/x/.antigravity/antigravity/bin",
    "/Users/x/flutter/bin",
    "/opt/homebrew/opt/ruby/bin",
    "/opt/homebrew/lib/ruby/gems/4.0.0/bin",
  ];

  it("adopts the .zshrc directories the non-interactive boot probe could not see", async () => {
    const nonInteractive = "/opt/homebrew/bin:/usr/bin:/bin";
    const { bootstrap, logs, currentPath } = scriptedBootstrap({
      loginPath: nonInteractive,
      interactivePath: async () => [...ZSHRC_DIRECTORIES, nonInteractive].join(":"),
    });

    const outcome = await bootstrap.applyInteractive();
    expect(outcome).toEqual({
      kind: "adopted",
      path: currentPath(),
      added: ZSHRC_DIRECTORIES,
    });
    for (const directory of ZSHRC_DIRECTORIES) {
      expect(currentPath().split(":")).toContain(directory);
    }
    expect(logs.at(-1)).toContain("(+7: /Users/x/.bun/bin");
  });

  it("keeps the bin dir first, which is the invariant every wrapper rests on", async () => {
    const { bootstrap, currentPath } = scriptedBootstrap({
      loginPath: "/opt/homebrew/bin:/usr/bin",
      interactivePath: async () => "/Users/x/.bun/bin:/opt/homebrew/bin:/usr/bin",
    });
    await bootstrap.applyInteractive();
    expect(currentPath().split(":")[0]).toBe("/profile/bin");
  });

  // Adoption is additive by contract: a session must never lose a directory it
  // could previously reach, however impoverished the interactive answer is.
  it("never removes a directory, even when the interactive shell reports fewer", async () => {
    const { bootstrap, currentPath } = scriptedBootstrap({
      loginPath: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      interactivePath: async () => "/usr/bin",
    });
    const before = new Set<string>();
    await bootstrap.apply();
    for (const entry of currentPath().split(":")) before.add(entry);

    await bootstrap.applyInteractive();
    const after = new Set(currentPath().split(":"));
    for (const entry of before) expect(after).toContain(entry);
  });

  // Reusing decideLoginPathAdoption's own verdict here would say "adopted" for
  // every host: by the second pass the bin dir always leads, so the union can
  // never equal the current string. The installed PATH is what is compared.
  it("reports already-complete when the interactive shell adds nothing", async () => {
    const login = "/opt/homebrew/bin:/usr/bin:/bin";
    const { bootstrap, mutations, logs } = scriptedBootstrap({
      loginPath: login,
      interactivePath: async () => login,
    });

    await expect(bootstrap.applyInteractive()).resolves.toEqual({ kind: "already-complete" });
    expect(new Set(mutations).size).toBe(1);
    expect(logs.at(-1)).toBe("[volli] PATH kept (interactive login shell adds nothing)");
  });

  it("reports probe-failed without disturbing the PATH boot adopted", async () => {
    const { bootstrap, currentPath, logs } = scriptedBootstrap({
      loginPath: "/opt/homebrew/bin:/usr/bin",
      interactivePath: async () => null,
    });
    await bootstrap.apply();
    const adopted = currentPath();

    await expect(bootstrap.applyInteractive()).resolves.toEqual({ kind: "probe-failed" });
    expect(currentPath()).toBe(adopted);
    expect(logs.at(-1)).toBe("[volli] PATH kept (interactive login shell probe failed)");
  });

  // A wedged `.zshrc` reaches this as a rejection just as readily as a `null`,
  // and neither may become an unhandled rejection on a fire-and-forget path.
  it("treats a rejected interactive probe as a probe failure, not a crash", async () => {
    const { bootstrap } = scriptedBootstrap({
      loginPath: "/opt/homebrew/bin",
      interactivePath: async () => Promise.reject(new Error("rc wedged")),
    });
    await expect(bootstrap.applyInteractive()).resolves.toEqual({ kind: "probe-failed" });
  });

  it("runs the interactive probe once, however many callers ask", async () => {
    let probeCount = 0;
    const { bootstrap } = scriptedBootstrap({
      loginPath: "/opt/homebrew/bin",
      interactivePath: async () => {
        probeCount += 1;
        return "/Users/x/.bun/bin:/opt/homebrew/bin";
      },
    });
    const first = bootstrap.applyInteractive();
    expect(bootstrap.applyInteractive()).toBe(first);
    await first;
    await bootstrap.applyInteractive();
    expect(probeCount).toBe(1);
  });

  // Two writers of one process.env.PATH is how a late boot resolve would clobber
  // the second pass, or the reverse. The pass is sequenced behind adoption.
  it("never runs ahead of boot adoption", async () => {
    const order: string[] = [];
    let releaseBoot: ((path: string | null) => void) | undefined;
    const bootstrap = createLoginPathBootstrap({
      binDir: "/profile/bin",
      readCurrentPath: () => BARE_LAUNCHD_PATH,
      writePath: () => {},
      resolveLoginPath: () =>
        new Promise((resolve) => {
          releaseBoot = resolve;
        }),
      resolveInteractiveLoginPath: async () => {
        order.push("interactive-probe");
        return "/opt/homebrew/bin";
      },
      log: (line) => order.push(line),
    });

    const pass = bootstrap.applyInteractive();
    await Promise.resolve();
    expect(order).toEqual([]);

    releaseBoot?.("/opt/homebrew/bin:/usr/bin");
    await pass;
    expect(order[0]).toContain("PATH adopted from login shell");
    expect(order[1]).toBe("interactive-probe");
  });

  it("reads as pending until the pass has answered, and never as a failure", async () => {
    let release: ((path: string | null) => void) | undefined;
    const { bootstrap } = scriptedBootstrap({
      loginPath: "/opt/homebrew/bin",
      interactivePath: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });

    expect(bootstrap.interactiveProvenance()).toBe("pending");
    const pass = bootstrap.applyInteractive();
    await bootstrap.apply();
    expect(bootstrap.interactiveProvenance()).toBe("pending");

    release?.("/Users/x/.bun/bin:/opt/homebrew/bin");
    await pass;
    expect(bootstrap.interactiveProvenance()).toBe("adopted");
  });

  it("does not ask the interactive shell unless the pass actually runs", async () => {
    let probeCount = 0;
    const { bootstrap } = scriptedBootstrap({
      loginPath: "/opt/homebrew/bin",
      interactivePath: async () => {
        probeCount += 1;
        return "/opt/homebrew/bin";
      },
    });
    await bootstrap.apply();
    expect(probeCount).toBe(0);
  });

  it("re-probes both shells, keeps every directory, and names what the repair added", async () => {
    let currentPath = BARE_LAUNCHD_PATH;
    const bootstrap = createLoginPathBootstrap({
      binDir: "/profile/bin",
      readCurrentPath: () => currentPath,
      writePath: (path) => {
        currentPath = path;
      },
      resolveLoginPath: async () => "/opt/homebrew/bin:/usr/bin",
      resolveInteractiveLoginPath: async () => "/Users/x/.bun/bin:/opt/homebrew/bin:/usr/bin",
      log: () => {},
    });
    await bootstrap.applyInteractive();
    const before = new Set(currentPath.split(":"));

    const repaired = await bootstrap.repair(
      async () => "/new/login/bin:/opt/homebrew/bin:/usr/bin",
      async () => "/new/interactive/bin:/new/login/bin:/opt/homebrew/bin:/usr/bin",
    );

    expect(repaired).toEqual({
      path: "/profile/bin:/new/interactive/bin:/new/login/bin:/opt/homebrew/bin:/usr/bin:/Users/x/.bun/bin:/bin:/usr/sbin:/sbin",
      provenance: "adopted",
      added: ["/new/login/bin"],
      interactiveProvenance: "adopted",
      interactiveAdded: ["/new/interactive/bin"],
    });
    expect(currentPath).toBe(repaired.path);
    expect(currentPath.split(":")[0]).toBe("/profile/bin");
    for (const entry of before) expect(currentPath.split(":")).toContain(entry);

    const repeated = await bootstrap.repair(
      async () => "/new/login/bin:/opt/homebrew/bin:/usr/bin",
      async () => "/new/interactive/bin:/new/login/bin:/opt/homebrew/bin:/usr/bin",
    );
    expect(repeated).toEqual({
      path: repaired.path,
      provenance: "adopted",
      added: [],
      interactiveProvenance: "adopted",
      interactiveAdded: [],
    });
    await expect(bootstrap.apply()).resolves.toMatchObject({ kind: "adopted", added: [] });
    expect(bootstrap.interactiveProvenance()).toBe("adopted");
  });
});
