import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { readEnvironmentRun } from "./environment-runs";
import { workingCopyRecordPath } from "./first-run";
import { terminalSetupCommand } from "./terminal-setup";

let home: string;
let worktreePath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "volli-terminal-setup-home-"));
  worktreePath = mkdtempSync(join(tmpdir(), "volli-terminal-setup-wt-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(worktreePath, { recursive: true, force: true });
});

const params = (storedCommand: string | null, shellPath = "/bin/zsh") => ({
  ticketId: "t",
  displayId: "VC-7",
  projectId: "p",
  worktreePath,
  storedCommand,
  shellPath,
  now: () => 3,
});

describe("terminalSetupCommand", () => {
  it("has nothing to type when the working copy has no recipe", () => {
    expect(terminalSetupCommand({ home }, params(null))).toBeNull();
  });

  it("types the stored command as it always was, and records its outcome", () => {
    const setup = terminalSetupCommand({ home }, params("pnpm install"));
    expect(setup?.command).toBe("pnpm install");

    setup!.onSettled({ exitCode: 0 });
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toMatchObject({
      source: "legacyCommand",
      reason: "new-working-copy",
      outcome: "succeeded",
      summary: "The project's setup command succeeded.",
      startedAt: 3,
      endedAt: 3,
    });
  });

  it("types the repository's .agents/setup under the recipe's variables, with nothing on stdin", () => {
    mkdirSync(join(worktreePath, ".agents"));
    writeFileSync(
      join(worktreePath, ".agents", "setup"),
      'read -r line || printf "%s %s" "$VOLLI_TICKET" "$VOLLI_SETUP_REASON" > env.txt\n',
    );

    const setup = terminalSetupCommand({ home }, params("pnpm install", "-zsh"));

    execFileSync("/bin/sh", ["-c", setup!.command], { cwd: worktreePath });
    expect(readFileSync(join(worktreePath, "env.txt"), "utf8")).toBe("VC-7 new-working-copy");
    setup!.onSettled({ exitCode: 4 });
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toMatchObject({
      source: "repo",
      outcome: "failed",
      exitCode: 4,
      summary: "`.agents/setup` exited with code 4.",
    });
  });

  it("quotes for fish, calls a later run a retry, and says when the shell died first", () => {
    mkdirSync(join(worktreePath, ".agents"));
    writeFileSync(join(worktreePath, ".agents", "setup"), "true\n");
    terminalSetupCommand({ home }, params(null))!.onSettled({ exitCode: 1 });

    const setup = terminalSetupCommand({ home }, params(null, "/opt/homebrew/bin/fish"));
    expect(setup?.command).toContain("VOLLI_SETUP_REASON='retry'");
    setup!.onSettled({ exitCode: null });
    expect(readEnvironmentRun({ home }, worktreePath, "setup")).toMatchObject({
      reason: "retry",
      exitCode: null,
      summary: "`.agents/setup` did not finish: the terminal's shell exited first.",
    });
  });

  it("calls a run after an unreadable record a retry, and survives a record it cannot write", () => {
    mkdirSync(join(worktreePath, ".agents"));
    writeFileSync(join(worktreePath, ".agents", "setup"), "true\n");
    terminalSetupCommand({ home }, params(null))!.onSettled({ exitCode: 1 });
    const record = workingCopyRecordPath({ home }, worktreePath, "setup-run.json");
    writeFileSync(record, "{");

    const setup = terminalSetupCommand({ home }, params(null));
    expect(setup?.command).toContain("VOLLI_SETUP_REASON='retry'");
    rmSync(record);
    mkdirSync(record);
    expect(() => setup!.onSettled({ exitCode: 0 })).not.toThrow();
  });
});
