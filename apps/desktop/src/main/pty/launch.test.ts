import { afterEach, describe, expect, it } from "vite-plus/test";
import type { HarnessId } from "@volli/shared";
import { createAttachment } from "../db/attachments-repo";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import type { EnsureOutcome } from "../worktree";
import type { SessionScope } from "./scope";
import { composeWorktreeLaunchCommand } from "./launch";

let ctx: TestDb;

afterEach(() => {
  ctx.cleanup();
});

/** A migrated db with project `proj-1` and worktree ticket `tk1`. */
function setup(): void {
  ctx = openTestDb();
  insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo/project-1", ticketPrefix: "VC" }));
  insertTicket(ctx.db, testTicket("proj-1", { id: "tk1", ticketNumber: 1, usesWorktree: true }));
}

/** The worktree scope carrier, defaulting to a kickoff-less/resume-less shape. */
function worktreeScope(
  overrides: Partial<NonNullable<SessionScope["worktree"]>> = {},
): NonNullable<SessionScope["worktree"]> {
  return {
    ticketId: "tk1",
    projectPath: "/repo/project-1",
    setupCommand: null,
    kickoff: null,
    resumeCommand: null,
    ...overrides,
  };
}

const identity: EnsureOutcome["identity"] = {
  worktreePath: "/wt/VC-1",
  branch: "volli/VC-1-x",
  baseBranch: "main",
};

describe("composeWorktreeLaunchCommand", () => {
  it("returns the pre-built resume line verbatim (no orientation preamble)", () => {
    setup();
    const worktree = worktreeScope({ resumeCommand: "claude --resume 'abc'" });

    const line = composeWorktreeLaunchCommand(ctx.db, worktree, identity, "/wt/VC-1");
    expect(line).toBe("claude --resume 'abc'");
  });

  it("composes the harness command opening with the orientation preamble for a kickoff", () => {
    setup();
    const worktree = worktreeScope({
      kickoff: { harnessId: "codex" as HarnessId, prompt: "run tests" },
    });

    const line = composeWorktreeLaunchCommand(ctx.db, worktree, identity, "/wt/VC-1");
    expect(line).not.toBeNull();
    expect(line).toContain("codex");
    expect(line).toContain("isolated git worktree");
    expect(line).toContain("/wt/VC-1");
    expect(line).toContain("volli/VC-1-x");
    expect(line).toContain("run tests");
    // No attachments on this ticket → no Attachments section.
    expect(line).not.toContain("## Attachments");
  });

  it("appends the re-derived Attachments section after the prompt when the ticket has attachments", () => {
    setup();
    createAttachment(
      ctx.db,
      { ticketId: "tk1", kind: "url", url: "https://example.com/design", label: "design doc" },
      Date.now(),
    );
    const worktree = worktreeScope({
      kickoff: { harnessId: "codex" as HarnessId, prompt: "run tests" },
    });

    const line = composeWorktreeLaunchCommand(ctx.db, worktree, identity, "/wt/VC-1");
    expect(line).not.toBeNull();
    expect(line).toContain("## Attachments");
    expect(line).toContain("https://example.com/design");
    expect(line).toContain("design doc");
    // The section trails the ticket prompt.
    expect(line!.indexOf("run tests")).toBeLessThan(line!.indexOf("## Attachments"));
  });

  it("uses an empty-string branch placeholder in the preamble when identity.branch is null", () => {
    setup();
    const worktree = worktreeScope({ kickoff: { harnessId: "codex" as HarnessId, prompt: "go" } });
    const noBranch: EnsureOutcome["identity"] = {
      worktreePath: "/wt/VC-1",
      branch: null,
      baseBranch: "main",
    };

    const line = composeWorktreeLaunchCommand(ctx.db, worktree, noBranch, "/wt/VC-1");
    expect(line).not.toBeNull();
    expect(line).toContain("isolated git worktree");
    // The empty branch renders as bare backticks, never the string "null".
    expect(line).toContain("on branch ``");
    expect(line).not.toContain("null");
  });

  it("returns null when the worktree carries neither a resume line nor a kickoff", () => {
    setup();
    const line = composeWorktreeLaunchCommand(ctx.db, worktreeScope(), identity, "/wt/VC-1");
    expect(line).toBeNull();
  });
});
