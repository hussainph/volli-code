import { promises as fs } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_HARNESS_ID,
  displayTicketId,
  projectSessionEnv,
  ticketSessionEnv,
} from "@volli/shared";
import type { CreateTerminalSessionRequest, HarnessId } from "@volli/shared";
import { createAttachment } from "../db/attachments-repo";
import { importAttachmentFile } from "../attachment-store";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { insertSession } from "../db/sessions-repo";
import { openTestDb, testProject, testSession, testTicket } from "../db/test-helpers";
import type { TestDb } from "../db/test-helpers";
import { resolveScope } from "./scope";

let ctx: TestDb;
const tmpDirs: string[] = [];

/** A throwaway real directory (attachments root / project checkout), cleaned in afterEach. */
async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  ctx.cleanup();
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A scratch (no-ticket) create request for `workspaceId`, with optional overrides. */
function scratchRequest(
  overrides: Partial<CreateTerminalSessionRequest> = {},
): CreateTerminalSessionRequest {
  return {
    workspaceId: overrides.workspaceId ?? "proj-1",
    cwd: overrides.cwd ?? "/repo/project-1",
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

/** A resume create request for `proj-1`/`tk1` picking up `sessionId`, with an optional kickoff. */
function resumeRequest(
  sessionId: string,
  extra: { kickoff?: { harnessId: HarnessId; prompt: string } } = {},
): CreateTerminalSessionRequest {
  return {
    workspaceId: "proj-1",
    cwd: "/repo/project-1",
    cols: 80,
    rows: 24,
    ticket: { ticketId: "tk1", resume: { sessionId }, ...extra },
  };
}

describe("resolveScope — scratch", () => {
  it("resolves a project-scoped scratch scope from the resolved project", () => {
    ctx = openTestDb();
    const project = testProject({ id: "proj-1", path: "/repo/project-1" });
    insertProject(ctx.db, project);

    const result = resolveScope(ctx.db, scratchRequest({ cwd: "/repo/elsewhere" }), "/attach-root");

    expect(result).toEqual({
      ok: true,
      scope: {
        projectId: "proj-1",
        ticketId: null,
        harnessId: DEFAULT_HARNESS_ID,
        launchKind: "shell",
        placement: "tab",
        cwd: "/repo/elsewhere",
        env: projectSessionEnv(project.path),
        title: "Terminal 1",
        artifactsRoot: project.path,
        launchCommand: null,
        worktree: null,
        resume: null,
      },
    });
  });

  it("numbers the scratch title 'Terminal N' from the existing scratch-session count", () => {
    ctx = openTestDb();
    const project = testProject({ id: "proj-1", path: "/repo/project-1" });
    insertProject(ctx.db, project);
    insertSession(ctx.db, testSession("proj-1", null));

    const result = resolveScope(ctx.db, scratchRequest(), "/attach-root");
    if (!result.ok) throw new Error("expected a scope");
    expect(result.scope.title).toBe("Terminal 2");
  });

  it("still resolves ok for an unresolvable project — empty env, null artifactsRoot", () => {
    ctx = openTestDb();

    const result = resolveScope(ctx.db, scratchRequest({ workspaceId: "ghost" }), "/attach-root");
    if (!result.ok) throw new Error("expected a scope");
    expect(result.scope.env).toEqual({});
    expect(result.scope.artifactsRoot).toBeNull();
    expect(result.scope.projectId).toBe("ghost");
  });

  it("normalizes placement to 'tab' unless it is exactly 'split'", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo/project-1" }));

    const split = resolveScope(ctx.db, scratchRequest({ placement: "split" }), "/attach-root");
    const omitted = resolveScope(ctx.db, scratchRequest(), "/attach-root");
    const bogus = resolveScope(
      ctx.db,
      scratchRequest({ placement: "floating" as "tab" }),
      "/attach-root",
    );
    if (!split.ok || !omitted.ok || !bogus.ok) throw new Error("expected scopes");
    expect(split.scope.placement).toBe("split");
    expect(omitted.scope.placement).toBe("tab");
    expect(bogus.scope.placement).toBe("tab");
  });
});

describe("resolveScope — ticket", () => {
  it("errors when the ticket does not exist", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo/project-1" }));

    const result = resolveScope(
      ctx.db,
      {
        workspaceId: "proj-1",
        cwd: "/repo/project-1",
        cols: 80,
        rows: 24,
        ticket: { ticketId: "ghost" },
      },
      "/attach-root",
    );
    expect(result).toEqual({ ok: false, error: "Unknown ticket" });
  });

  it("resolves a non-worktree ticket shell scope (no kickoff) with the ticket's preferred harness", () => {
    ctx = openTestDb();
    const project = testProject({ id: "proj-1", path: "/repo/project-1", ticketPrefix: "VC" });
    insertProject(ctx.db, project);
    insertTicket(
      ctx.db,
      testTicket("proj-1", {
        id: "tk1",
        ticketNumber: 12,
        usesWorktree: false,
        preferredHarnessId: "codex",
      }),
    );

    const result = resolveScope(
      ctx.db,
      {
        workspaceId: "proj-1",
        cwd: "/repo/project-1",
        cols: 80,
        rows: 24,
        ticket: { ticketId: "tk1" },
      },
      "/attach-root",
    );
    expect(result).toEqual({
      ok: true,
      scope: {
        projectId: "proj-1",
        ticketId: "tk1",
        harnessId: "codex",
        launchKind: "shell",
        placement: "tab",
        cwd: project.path,
        env: ticketSessionEnv(project.path, displayTicketId("VC", 12)),
        title: "Session 1",
        artifactsRoot: project.path,
        launchCommand: null,
        worktree: null,
        resume: null,
      },
    });
  });

  it("builds the harness launch command and appends the Attachments section for a non-worktree kickoff", async () => {
    const projectDir = await tmpDir("volli-scope-proj-");
    const attachRoot = await tmpDir("volli-scope-attach-");
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "proj-1", path: projectDir, ticketPrefix: "VC" }));
    insertTicket(
      ctx.db,
      testTicket("proj-1", { id: "tk1", ticketNumber: 12, usesWorktree: false }),
    );
    // A real file attachment whose bytes exist under the attachments root.
    const attachment = createAttachment(
      ctx.db,
      { ticketId: "tk1", kind: "file", fileName: "spec.png", label: "homepage mock" },
      Date.now(),
    );
    const source = join(await tmpDir("volli-scope-src-"), "spec.png");
    await fs.writeFile(source, "spec bytes");
    importAttachmentFile(attachRoot, attachment.id, source, "spec.png");

    const result = resolveScope(
      ctx.db,
      {
        workspaceId: "proj-1",
        cwd: projectDir,
        cols: 80,
        rows: 24,
        ticket: { ticketId: "tk1", kickoff: { harnessId: "codex", prompt: "run the tests" } },
      },
      attachRoot,
    );
    if (!result.ok) throw new Error(`expected a scope, got ${result.error}`);

    const launch = result.scope.launchCommand;
    expect(launch).not.toBeNull();
    expect(launch).toContain("codex");
    expect(launch).toContain("run the tests");
    expect(launch).toContain("## Attachments");
    expect(launch).toContain(".volli/attachments/spec.png");
    expect(launch).toContain("homepage mock");
    // The bytes were materialized into the PROJECT checkout (the session root).
    await expect(
      fs.readFile(join(projectDir, ".volli", "attachments", "spec.png"), "utf8"),
    ).resolves.toBe("spec bytes");
  });

  it("surfaces a materialize failure (an attachment's bytes are missing) as the scope error", async () => {
    const projectDir = await tmpDir("volli-scope-proj-");
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "proj-1", path: projectDir }));
    insertTicket(ctx.db, testTicket("proj-1", { id: "tk1", ticketNumber: 1, usesWorktree: false }));
    // A file attachment row with no bytes on disk → materialize throws.
    createAttachment(
      ctx.db,
      { ticketId: "tk1", kind: "file", fileName: "missing.png", label: "the missing one" },
      Date.now(),
    );

    const result = resolveScope(
      ctx.db,
      {
        workspaceId: "proj-1",
        cwd: projectDir,
        cols: 80,
        rows: 24,
        ticket: { ticketId: "tk1", kickoff: { harnessId: "codex", prompt: "go" } },
      },
      "/no-such-attach-root",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a materialize failure");
    expect(result.error).toContain("the missing one");
  });
});

describe("resolveScope — worktree", () => {
  it("defers a worktree kickoff's launchCommand (null) and carries the raw kickoff on `worktree`", () => {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "wp", path: "/repo/wp", ticketPrefix: "WP", setupCommand: "pnpm install" }),
    );
    insertTicket(ctx.db, testTicket("wp", { id: "wt1", ticketNumber: 20, usesWorktree: true }));

    const result = resolveScope(
      ctx.db,
      {
        workspaceId: "wp",
        cwd: "/repo/wp",
        cols: 80,
        rows: 24,
        ticket: { ticketId: "wt1", kickoff: { harnessId: "codex", prompt: "go" } },
      },
      "/attach-root",
    );
    if (!result.ok) throw new Error(`expected a scope, got ${result.error}`);

    expect(result.scope.launchCommand).toBeNull();
    expect(result.scope.launchKind).toBe("agent");
    expect(result.scope.worktree).toEqual({
      ticketId: "wt1",
      projectPath: "/repo/wp",
      setupCommand: "pnpm install",
      kickoff: { harnessId: "codex", prompt: "go" },
      resumeCommand: null,
    });
    expect(result.scope.resume).toBeNull();
  });

  it("numbers the ticket session title 'Session N' from the existing ticket-session count", () => {
    ctx = openTestDb();
    insertProject(ctx.db, testProject({ id: "proj-1", path: "/repo/project-1" }));
    insertTicket(ctx.db, testTicket("proj-1", { id: "tk1", ticketNumber: 1, usesWorktree: false }));
    insertSession(ctx.db, testSession("proj-1", "tk1"));

    const result = resolveScope(
      ctx.db,
      {
        workspaceId: "proj-1",
        cwd: "/repo/project-1",
        cols: 80,
        rows: 24,
        ticket: { ticketId: "tk1" },
      },
      "/attach-root",
    );
    if (!result.ok) throw new Error("expected a scope");
    expect(result.scope.title).toBe("Session 2");
  });
});

describe("resolveScope — resume", () => {
  /** A migrated db with a non-worktree ticket `tk1` under project `proj-1`. */
  function setup(overrides: { usesWorktree?: boolean } = {}): void {
    ctx = openTestDb();
    insertProject(
      ctx.db,
      testProject({ id: "proj-1", path: "/repo/project-1", ticketPrefix: "VC" }),
    );
    insertTicket(
      ctx.db,
      testTicket("proj-1", {
        id: "tk1",
        ticketNumber: 12,
        usesWorktree: overrides.usesWorktree ?? false,
      }),
    );
  }

  /** Inserts an ENDED session under `ticketId` and returns its record. */
  function insertEndedAgent(
    ticketId: string,
    harnessSessionId: string | null,
    overrides: {
      harnessId?: HarnessId;
      launchKind?: "agent" | "shell";
      endedAt?: number | null;
    } = {},
  ) {
    const record = testSession("proj-1", ticketId, {
      harnessId: overrides.harnessId ?? "claude-code",
      launchKind: overrides.launchKind ?? "agent",
    });
    record.harnessSessionId = harnessSessionId;
    record.endedAt = overrides.endedAt === undefined ? 1000 : overrides.endedAt;
    insertSession(ctx.db, record);
    return record;
  }

  it("rejects a request carrying both a kickoff and a resume", () => {
    setup();
    const prior = insertEndedAgent("tk1", "abc-123");
    const result = resolveScope(
      ctx.db,
      resumeRequest(prior.id, { kickoff: { harnessId: "codex", prompt: "go" } }),
      "/attach-root",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("cannot both");
  });

  it("rejects resuming an unknown session", () => {
    setup();
    const result = resolveScope(ctx.db, resumeRequest("no-such-session"), "/attach-root");
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("unknown session");
  });

  it("rejects resuming a session that belongs to another ticket", () => {
    setup();
    insertTicket(
      ctx.db,
      testTicket("proj-1", { id: "tk2", ticketNumber: 13, usesWorktree: false }),
    );
    const prior = insertEndedAgent("tk2", "abc-123");
    const result = resolveScope(ctx.db, resumeRequest(prior.id), "/attach-root");
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("another ticket");
  });

  it("rejects resuming a non-agent (shell) session", () => {
    setup();
    const prior = insertEndedAgent("tk1", null, { launchKind: "shell" });
    const result = resolveScope(ctx.db, resumeRequest(prior.id), "/attach-root");
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("agent session");
  });

  it("rejects resuming a session that is still live", () => {
    setup();
    const prior = insertEndedAgent("tk1", "abc-123", { endedAt: null });
    const result = resolveScope(ctx.db, resumeRequest(prior.id), "/attach-root");
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("still live");
  });

  it("rejects resuming a harness with no resume support, naming the harness", () => {
    setup();
    const prior = insertEndedAgent("tk1", "abc-123", {
      harnessId: "made-up-harness" as HarnessId,
    });
    const result = resolveScope(ctx.db, resumeRequest(prior.id), "/attach-root");
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("does not support resuming");
  });

  it("puts the resume line in launchCommand for a valid non-worktree resume", () => {
    setup();
    const prior = insertEndedAgent("tk1", "abc-123");
    const result = resolveScope(ctx.db, resumeRequest(prior.id), "/attach-root");
    if (!result.ok) throw new Error(`expected a scope, got ${result.error}`);
    expect(result.scope.launchKind).toBe("agent");
    expect(result.scope.harnessId).toBe("claude-code");
    expect(result.scope.launchCommand).toBe("claude --resume 'abc-123'");
    expect(result.scope.worktree).toBeNull();
  });

  it("defers the resume line onto worktree.resumeCommand for a valid worktree resume", () => {
    setup({ usesWorktree: true });
    const prior = insertEndedAgent("tk1", "wt-abc");
    const result = resolveScope(ctx.db, resumeRequest(prior.id), "/attach-root");
    if (!result.ok) throw new Error(`expected a scope, got ${result.error}`);
    expect(result.scope.launchCommand).toBeNull();
    expect(result.scope.worktree?.resumeCommand).toBe("claude --resume 'wt-abc'");
    expect(result.scope.worktree?.kickoff).toBeNull();
  });

  it("inherits the prior session's previousSessionId and harnessSessionId onto the resume scope", () => {
    setup();
    const prior = insertEndedAgent("tk1", "seed-xyz");
    const result = resolveScope(ctx.db, resumeRequest(prior.id), "/attach-root");
    if (!result.ok) throw new Error(`expected a scope, got ${result.error}`);
    expect(result.scope.resume).toEqual({
      previousSessionId: prior.id,
      harnessSessionId: "seed-xyz",
    });
  });
});
