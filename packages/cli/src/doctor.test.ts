import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { DoctorCheck } from "@volli/shared";
import {
  executableAt,
  observeEnvironment,
  processEnvironment,
  renderDoctorCheck,
  renderDoctorReport,
  resolveHere,
} from "./doctor";
import type { DoctorEnvironment } from "./doctor";

function environment(
  env: Record<string, string | undefined>,
  executables: readonly string[] = [],
): DoctorEnvironment {
  return { env, isExecutable: (path) => Promise.resolve(executables.includes(path)) };
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

  it("reports ZDOTDIR as null when unset rather than omitting it", async () => {
    expect((await observeEnvironment(environment({ PATH: "" })))["zdotDir"]).toBeNull();
  });

  it("reports ZDOTDIR when the shell integration is active", async () => {
    const observed = await observeEnvironment(environment({ PATH: "", ZDOTDIR: "/ud/shell/zsh" }));
    expect(observed["zdotDir"]).toBe("/ud/shell/zsh");
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
});

describe("processEnvironment", () => {
  it("reads this process's own environment, which is the environment under test", () => {
    expect(processEnvironment().env).toBe(process.env);
  });

  it("resolves through the real filesystem", async () => {
    expect(await processEnvironment().isExecutable("/definitely/not/here")).toBe(false);
  });
});
