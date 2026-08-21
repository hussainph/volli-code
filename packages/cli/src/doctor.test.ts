import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { DoctorCheck, SessionEnvRepair } from "@volli/shared";
import {
  entriesInDirectory,
  executableAt,
  observeEnvironment,
  processEnvironment,
  realPathOfFile,
  renderDoctorCheck,
  renderDoctorReport,
  resolveHere,
} from "./doctor";
import type { DoctorEnvironment } from "./doctor";

function environment(
  env: Record<string, string | undefined>,
  executables: readonly string[] = [],
  directories: Readonly<Record<string, readonly string[]>> = {},
): DoctorEnvironment {
  return {
    env,
    isExecutable: (path) => Promise.resolve(executables.includes(path)),
    entriesIn: (path) => Promise.resolve([...(directories[path] ?? [])]),
    // The test filesystem has no links, so a path is already its own real path.
    realPathOf: (path) => Promise.resolve(executables.includes(path) ? path : null),
  };
}

describe("resolveHere", () => {
  it("picks the first match, exactly as a shell would", async () => {
    const found = await resolveHere(
      ["/a", "/b"],
      "claude",
      environment({}, ["/a/claude", "/b/claude"]),
    );
    expect(found).toBe("/a/claude");
  });

  // Everywhere else in Volli the bin dir is skipped so the REAL binary can be
  // found. Here, finding our own wrapper first is the answer being sought.
  it("does not skip Volli's own bin dir", async () => {
    expect(await resolveHere(["/ud/bin"], "claude", environment({}, ["/ud/bin/claude"]))).toBe(
      "/ud/bin/claude",
    );
  });

  it("is null when nothing on PATH is executable", async () => {
    expect(await resolveHere(["/a"], "claude", environment({}, []))).toBeNull();
  });
});

describe("observeEnvironment", () => {
  it("reports this process's own PATH, split and emptied of blanks", async () => {
    const observed = await observeEnvironment(environment({ PATH: "/a::/b" }));
    expect(observed["pathEntries"]).toEqual(["/a", "/b"]);
  });

  it("survives an environment with no PATH at all", async () => {
    expect((await observeEnvironment(environment({})))["pathEntries"]).toEqual([]);
  });

  it("resolves every first-class harness command, and volli itself", async () => {
    const observed = await observeEnvironment(
      environment({ PATH: "/ud/bin" }, ["/ud/bin/claude", "/ud/bin/volli"]),
    );
    const resolved = observed["resolved"] as Record<string, string | null>;
    expect(resolved["claude"]).toBe("/ud/bin/claude");
    expect(resolved["codex"]).toBeNull();
    expect(observed["volliPath"]).toBe("/ud/bin/volli");
  });

  // VC-94: a machine with no harness installed still needs its contract tools
  // audited, so the observation measures them with or without a bin dir — and
  // a missing one is a measured null, not a key that never appeared.
  it("resolves every contract tool, found or missing", async () => {
    const observed = await observeEnvironment(
      environment({ PATH: "/ud/bin" }, ["/ud/bin/volli", "/ud/bin/git"]),
    );
    const resolved = observed["resolved"] as Record<string, string | null>;
    expect(resolved["git"]).toBe("/ud/bin/git");
    expect(resolved["gh"]).toBeNull();
    expect(resolved["node"]).toBeNull();
    expect(resolved["pnpm"]).toBeNull();
  });

  it("reports ZDOTDIR as null when unset rather than omitting it", async () => {
    expect((await observeEnvironment(environment({ PATH: "" })))["zdotDir"]).toBeNull();
  });

  it("reports ZDOTDIR when the shell integration is active", async () => {
    const observed = await observeEnvironment(environment({ PATH: "", ZDOTDIR: "/ud/shell/zsh" }));
    expect(observed["zdotDir"]).toBe("/ud/shell/zsh");
  });

  // The defect this closes: doctor iterates the wrappers main WROTE, which
  // includes a registered manifest's command — and a command nobody resolved
  // was reported as resolving to nothing, for a harness that works.
  it("resolves every wrapper in the bin dir, not just the built-in harnesses", async () => {
    const observed = await observeEnvironment(
      environment(
        { PATH: "/ud/bin", VOLLI_BIN_DIR: "/ud/bin" },
        ["/ud/bin/my-harness", "/ud/bin/volli"],
        { "/ud/bin": ["claude", "my-harness", "volli", "volli.cjs"] },
      ),
    );
    const resolved = observed["resolved"] as Record<string, string | null>;
    expect(resolved["my-harness"]).toBe("/ud/bin/my-harness");
    // The launcher is not a harness, and reporting it as one would invent a check.
    expect(Object.keys(resolved)).not.toContain("volli");
    expect(Object.keys(resolved)).not.toContain("volli.cjs");
  });

  // A non-zsh session gets no shell chain, so no exported bin dir — but the
  // shim it just ran is sitting in that directory.
  it("finds the bin dir through the volli shim when the shell chain did not export it", async () => {
    const observed = await observeEnvironment(
      environment({ PATH: "/ud/bin" }, ["/ud/bin/volli", "/ud/bin/my-harness"], {
        "/ud/bin": ["my-harness", "volli"],
      }),
    );
    expect((observed["resolved"] as Record<string, string | null>)["my-harness"]).toBe(
      "/ud/bin/my-harness",
    );
  });

  it("reports only the built-ins when neither route finds a bin dir", async () => {
    const observed = await observeEnvironment(environment({ PATH: "/usr/bin" }));
    expect(Object.keys(observed["resolved"] as Record<string, string | null>)).toContain("claude");
    expect(observed["volliPath"]).toBeNull();
  });

  it("reports only the built-ins when the shim on PATH cannot be followed", async () => {
    const base = environment({ PATH: "/ud/bin" }, ["/ud/bin/volli", "/ud/bin/my-harness"], {
      "/ud/bin": ["my-harness"],
    });
    const observed = await observeEnvironment({ ...base, realPathOf: async () => null });
    expect(Object.keys(observed["resolved"] as Record<string, string | null>)).not.toContain(
      "my-harness",
    );
    // Unresolvable falls back to the PATH-walked value rather than becoming
    // null outright — a stale entry is still worth reporting as-is.
    expect(observed["volliPath"]).toBe("/ud/bin/volli");
  });

  // The defect this closes: a `volli` reached through the one-time
  // `/usr/local/bin` symlink resolves here to the SYMLINK's own path, which
  // reads as a different install from main's shim path even though they name
  // the same file. `volli doctor` compares this value byte-for-byte against
  // main's own (`volliCheck`, packages/shared/src/doctor.ts), so it has to be
  // the REAL path or a correct install reports "another Volli install owns
  // the link".
  it("reports volli's real path when PATH found it through a symlink", async () => {
    const base = environment({ PATH: "/usr/local/bin" }, ["/usr/local/bin/volli"]);
    const observed = await observeEnvironment({
      ...base,
      realPathOf: async (path) =>
        path === "/usr/local/bin/volli"
          ? "/Users/me/Library/Application Support/Volli Code/bin/volli"
          : null,
    });
    expect(observed["volliPath"]).toBe(
      "/Users/me/Library/Application Support/Volli Code/bin/volli",
    );
  });

  it("survives a bin dir that cannot be read", async () => {
    const observed = await observeEnvironment(
      environment({ PATH: "/ud/bin", VOLLI_BIN_DIR: "/ud/gone" }, ["/ud/bin/volli"]),
    );
    expect(observed["volliPath"]).toBe("/ud/bin/volli");
  });

  // The session id rides in the request context main already builds; a second
  // copy here could disagree with it.
  it("does not carry the session id", async () => {
    const observed = await observeEnvironment(environment({ PATH: "", VOLLI_SESSION: "s-1" }));
    expect(Object.keys(observed)).not.toContain("sessionId");
  });
});

const check = (overrides: Partial<DoctorCheck> = {}): DoctorCheck => ({
  id: "path-position",
  title: "Volli's bin is first on PATH",
  status: "ok",
  detail: "position 1 of 30",
  ...overrides,
});

describe("renderDoctorCheck", () => {
  it("marks a passing check and shows what was seen", () => {
    expect(renderDoctorCheck(check())).toBe("✓ Volli's bin is first on PATH\n    position 1 of 30");
  });

  it("distinguishes a failure from a warning at a glance", () => {
    expect(renderDoctorCheck(check({ status: "fail" })).startsWith("✗")).toBe(true);
    expect(renderDoctorCheck(check({ status: "warn" })).startsWith("!")).toBe(true);
  });

  it("shows the remedy only when there is one", () => {
    expect(renderDoctorCheck(check())).not.toContain("→");
    expect(renderDoctorCheck(check({ remedy: "Open a new terminal." }))).toContain(
      "→ Open a new terminal.",
    );
  });

  it("ends a report with its summary", () => {
    expect(renderDoctorReport([check()], "All 1 checks passed.")).toBe(
      "✓ Volli's bin is first on PATH\n    position 1 of 30\n\nAll 1 checks passed.\n",
    );
  });

  it("reports the repair's two outcomes, exact additions, and its scope", () => {
    const repair: SessionEnvRepair = {
      path: "/volli/bin:/Users/x/.bun/bin:/opt/homebrew/bin:/usr/bin",
      provenance: "adopted",
      added: ["/opt/homebrew/bin"],
      interactiveProvenance: "adopted",
      interactiveAdded: ["/Users/x/.bun/bin"],
    };

    expect(renderDoctorReport([check()], "All 1 checks passed.", repair)).toContain(
      "Session PATH repair\n" +
        "    env.path  /volli/bin:/Users/x/.bun/bin:/opt/homebrew/bin:/usr/bin\n" +
        "    env.provenance  adopted\n" +
        "    env.added  /opt/homebrew/bin\n" +
        "    env.interactiveProvenance  adopted\n" +
        "    env.interactiveAdded  /Users/x/.bun/bin\n" +
        "    Sessions started after this repair use this PATH. This running Session keeps the environment it started with.",
    );
    expect(
      renderDoctorReport([check()], "All 1 checks passed.", {
        ...repair,
        added: [],
        interactiveAdded: [],
      }),
    ).toContain(
      "    env.added  -\n    env.interactiveProvenance  adopted\n    env.interactiveAdded  -",
    );
  });
});

describe("executableAt", () => {
  it("agrees with the filesystem about what a shell could run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-doctor-"));
    const runnable = join(dir, "runnable");
    const plain = join(dir, "plain");
    await writeFile(runnable, "#!/bin/sh\n");
    await chmod(runnable, 0o755);
    await writeFile(plain, "data");
    await chmod(plain, 0o644);

    expect(await executableAt(runnable)).toBe(true);
    expect(await executableAt(plain)).toBe(false);
    expect(await executableAt(join(dir, "absent"))).toBe(false);
  });

  // access(X_OK) alone passes for a directory; a shell would not run one, so
  // a directory named after a tool must not be reported as the tool.
  it("refuses a directory, however executable its mode bits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-doctor-"));
    const toolShapedDir = join(dir, "git");
    await mkdir(toolShapedDir, { recursive: true });

    expect(await executableAt(toolShapedDir)).toBe(false);
  });
});

describe("entriesInDirectory", () => {
  it("lists what a directory holds, and nothing when it cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-doctor-"));
    await writeFile(join(dir, "my-harness"), "#!/bin/sh\n");
    expect(await entriesInDirectory(dir)).toEqual(["my-harness"]);
    expect(await entriesInDirectory(join(dir, "absent"))).toEqual([]);
  });
});

describe("realPathOfFile", () => {
  // The global `volli` link is a symlink into the bin dir; following it is the
  // only way a plain terminal learns where the wrappers live.
  it("follows a symlink to its target, and is null when there is nothing to follow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "volli-doctor-"));
    const target = join(dir, "volli");
    const link = join(dir, "linked");
    await writeFile(target, "#!/bin/sh\n");
    await symlink(target, link);
    expect(await realPathOfFile(link)).toBe(await realPathOfFile(target));
    expect(await realPathOfFile(join(dir, "absent"))).toBeNull();
  });
});

describe("processEnvironment", () => {
  it("reads this process's own environment, which is the environment under test", () => {
    expect(processEnvironment().env).toBe(process.env);
  });

  it("resolves through the real filesystem", async () => {
    expect(await processEnvironment().isExecutable("/definitely/not/here")).toBe(false);
    expect(await processEnvironment().entriesIn("/definitely/not/here")).toEqual([]);
    expect(await processEnvironment().realPathOf("/definitely/not/here")).toBeNull();
  });
});
