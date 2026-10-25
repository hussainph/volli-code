import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  localRunnerKind,
  recipeCommandLine,
  recipeEnvironment,
  recipeInvocation,
  resolveRecipe,
} from "./recipe";

let workingCopy: string;

beforeEach(() => {
  workingCopy = mkdtempSync(join(tmpdir(), "volli-recipe-"));
});

afterEach(() => rmSync(workingCopy, { recursive: true, force: true }));

function writeRecipe(script: "setup" | "resume", body: string, mode = 0o644): string {
  mkdirSync(join(workingCopy, ".agents"), { recursive: true });
  const file = join(workingCopy, ".agents", script);
  writeFileSync(file, body);
  chmodSync(file, mode);
  return file;
}

describe("resolveRecipe", () => {
  it("prefers the working copy's own file over the stored command, and never combines them", () => {
    const file = writeRecipe("setup", "#!/bin/sh\necho hi\n", 0o755);

    const recipe = resolveRecipe(workingCopy, "setup", "pnpm install");

    expect(recipe).toMatchObject({ source: "repo", script: "setup", file, form: "exec" });
    expect(recipe?.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runs a file without an exec bit or a shebang through bash", () => {
    writeRecipe("setup", "#!/bin/sh\necho hi\n");
    expect(resolveRecipe(workingCopy, "setup", null)).toMatchObject({ form: "bash" });

    writeRecipe("setup", "echo hi\n", 0o755);
    expect(resolveRecipe(workingCopy, "setup", null)).toMatchObject({ form: "bash" });

    writeRecipe("setup", "", 0o755);
    expect(resolveRecipe(workingCopy, "setup", null)).toMatchObject({ form: "bash" });
  });

  it("falls back to the stored command for setup only, trimmed, and to nothing", () => {
    expect(resolveRecipe(workingCopy, "setup", "  pnpm install  ")).toMatchObject({
      source: "legacyCommand",
      command: "pnpm install",
    });
    expect(resolveRecipe(workingCopy, "setup", "   ")).toBeNull();
    expect(resolveRecipe(workingCopy, "setup", null)).toBeNull();
    expect(resolveRecipe(workingCopy, "resume", "pnpm install")).toBeNull();
  });

  it("ignores a directory where the script would be", () => {
    mkdirSync(join(workingCopy, ".agents", "setup"), { recursive: true });
    expect(resolveRecipe(workingCopy, "setup", null)).toBeNull();
  });

  it("digests what runs, so a changed recipe reads as changed", () => {
    writeRecipe("resume", "a\n");
    const first = resolveRecipe(workingCopy, "resume", null)?.sha;
    writeRecipe("resume", "b\n");
    expect(resolveRecipe(workingCopy, "resume", null)?.sha).not.toBe(first);
  });
});

describe("recipe invocation and environment", () => {
  it("names the runner kind by platform", () => {
    expect(localRunnerKind("darwin")).toBe("mac");
    expect(localRunnerKind("linux")).toBe("linux");
    expect(["mac", "linux"]).toContain(localRunnerKind());
  });

  it("tells a script where and why it runs", () => {
    const base = { runnerKind: "mac" as const, projectId: "p", ticket: "VC-1", workingCopy: "/wc" };
    expect(recipeEnvironment({ ...base, reason: { script: "setup", why: "retry" } })).toEqual({
      VOLLI: "1",
      VOLLI_RUNNER_KIND: "mac",
      VOLLI_PROJECT: "p",
      VOLLI_TICKET: "VC-1",
      VOLLI_WORKING_COPY: "/wc",
      VOLLI_SETUP_REASON: "retry",
      DEBIAN_FRONTEND: "noninteractive",
    });
    expect(recipeEnvironment({ ...base, reason: { script: "resume", why: "wake" } })).toMatchObject(
      { VOLLI_RESUME_REASON: "wake" },
    );
  });

  it("spawns the stored command in the shell, and a file directly or through bash", () => {
    expect(
      recipeInvocation(
        { source: "legacyCommand", script: "setup", command: "make", sha: "" },
        "/bin/zsh",
      ),
    ).toEqual({ file: "/bin/zsh", args: ["-c", "make"] });
    const repo = { source: "repo", script: "setup", file: "/wc/.agents/setup", sha: "" } as const;
    expect(recipeInvocation({ ...repo, form: "exec" }, "/bin/zsh")).toEqual({
      file: "/wc/.agents/setup",
      args: [],
    });
    expect(recipeInvocation({ ...repo, form: "bash" }, "/bin/zsh")).toEqual({
      file: "bash",
      args: ["/wc/.agents/setup"],
    });
  });

  it("types a line a POSIX shell runs with the variables exactly as given", () => {
    const file = writeRecipe("setup", 'printf "%s|%s" "$VOLLI_TICKET" "$ODD"\n');
    const line = recipeCommandLine(
      { source: "repo", script: "setup", file, form: "bash", sha: "" },
      { VOLLI_TICKET: "VC-1", ODD: `it's a \\ "quote"` },
      "posix",
    );

    expect(line.endsWith("< /dev/null")).toBe(true);
    expect(execFileSync("/bin/sh", ["-c", line], { encoding: "utf8" })).toBe(
      `VC-1|it's a \\ "quote"`,
    );
  });

  it("quotes for fish, which reads escapes inside single quotes, and runs an exec-form file", () => {
    const line = recipeCommandLine(
      { source: "repo", script: "setup", file: "/wc/it's", form: "exec", sha: "" },
      { A: "a\\b" },
      "fish",
    );
    expect(line).toBe("env A='a\\\\b' '/wc/it\\'s' < /dev/null");
  });
});
