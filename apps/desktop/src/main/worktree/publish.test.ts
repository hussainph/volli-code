/**
 * Composition tests for the Done-flow publish/commit orchestration
 * (`publish.ts`). The network verbs are driven through the injected
 * `scriptedNet` fake and git through `scriptedGit`, so these exercise the
 * SEQUENCING and DB side effects — push-failure recording, existing-PR
 * short-circuit (and its no-duplicate-event guard), the pr-exists fallback,
 * taxonomy→friendly-message mapping, successful-create persistence, and the
 * best-effort fetch — against a real, fully-migrated SQLite db.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { TicketEvent } from "@volli/shared";

import { insertProject } from "../db/projects-repo";
import { getTicket, insertTicket } from "../db/tickets-repo";
import { listTicketEvents } from "../db/events-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { commitTicketRemaining, publishTicketBranch, type PublishDeps } from "./publish";
import { scriptedGit } from "./scripted-git";
import { netFailure, scriptedNet } from "./scripted-net";
import { GitError } from "./git";
import type { WorktreeDeps } from "./types";

let harness: TestDb;

afterEach(() => {
  harness?.cleanup();
});

const WORKTREE_PATH = "/repo/.worktrees/VC-1";
const BRANCH = "volli/VC-1-thing";

/** Seeds a project + a ticket that already has a worktree/branch/base, ready to publish. */
function seedTicket(overrides: { prUrl?: string | null } = {}): {
  db: TestDb["db"];
  ticketId: string;
} {
  harness = openTestDb();
  const project = testProject({ id: "p1", ticketPrefix: "VC" });
  insertProject(harness.db, project);
  const ticket = testTicket(project.id, {
    id: "t1",
    ticketNumber: 1,
    title: "Wire the thing",
    body: "Make it work.",
    worktreePath: WORKTREE_PATH,
    branch: BRANCH,
    baseBranch: "main",
  });
  insertTicket(harness.db, { ...ticket, prUrl: overrides.prUrl ?? null });
  return { db: harness.db, ticketId: ticket.id };
}

/** A git runner that answers only what the commit path needs (sequencer probe + status/add/commit). */
function commitGit(status: string): WorktreeDeps["git"] {
  return scriptedGit((args) => {
    if (args[0] === "rev-parse" && args[1] === "--git-dir") return "/repo/.worktrees/VC-1/.git";
    if (args[0] === "status") return status;
    return "";
  }).git;
}

function events(db: TestDb["db"], ticketId: string): TicketEvent[] {
  return listTicketEvents(db, ticketId);
}

describe("publishTicketBranch", () => {
  it("records worktree_failed(push) and errs when the push is rejected", async () => {
    const { db, ticketId } = seedTicket();
    const { run, calls } = scriptedNet((file, args) => {
      if (file === "git" && args[0] === "fetch") return {};
      if (file === "git" && args[0] === "push") {
        throw netFailure({ stderr: "! [rejected] main -> main (non-fast-forward)", code: 1 });
      }
      return {};
    });
    const deps: PublishDeps = { db, git: scriptedGit(() => "").git, net: run };

    const result = await publishTicketBranch(deps, ticketId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/remote branch has moved/i);
    // gh is never reached once push fails.
    expect(calls.some((c) => c.file === "gh")).toBe(false);
    const failed = events(db, ticketId).find((e) => e.payload.kind === "worktree_failed");
    expect(failed?.payload).toMatchObject({ kind: "worktree_failed", stage: "push" });
    expect(getTicket(db, ticketId)?.prUrl).toBeNull();
  });

  it("short-circuits to an existing PR and records pr_opened once (stored url was empty)", async () => {
    const { db, ticketId } = seedTicket();
    const url = "https://github.com/acme/repo/pull/7";
    const { run } = scriptedNet((file, args) => {
      if (file === "git") return {};
      if (file === "gh" && args.includes("view")) return { stdout: `${url}\n` };
      return {};
    });
    const deps: PublishDeps = { db, git: scriptedGit(() => "").git, net: run };

    const result = await publishTicketBranch(deps, ticketId);

    expect(result).toEqual({ ok: true, value: { url, existing: true } });
    expect(getTicket(db, ticketId)?.prUrl).toBe(url);
    const opened = events(db, ticketId).filter((e) => e.payload.kind === "pr_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.payload).toEqual({ kind: "pr_opened", url });
  });

  it("does NOT record a duplicate pr_opened when the stored url already matches", async () => {
    const url = "https://github.com/acme/repo/pull/7";
    const { db, ticketId } = seedTicket({ prUrl: url });
    const { run } = scriptedNet((file, args) => {
      if (file === "git") return {};
      if (file === "gh" && args.includes("view")) return { stdout: `${url}\n` };
      return {};
    });
    const deps: PublishDeps = { db, git: scriptedGit(() => "").git, net: run };

    const result = await publishTicketBranch(deps, ticketId);

    expect(result).toEqual({ ok: true, value: { url, existing: true } });
    expect(events(db, ticketId).filter((e) => e.payload.kind === "pr_opened")).toHaveLength(0);
  });

  it("falls back to ghFindPr once when create reports pr-exists", async () => {
    const { db, ticketId } = seedTicket();
    const url = "https://github.com/acme/repo/pull/9";
    let viewCount = 0;
    const { run } = scriptedNet((file, args) => {
      if (file === "git") return {};
      if (file === "gh" && args.includes("view")) {
        viewCount += 1;
        // First find: no PR yet. Second (post-create fallback) find: it exists.
        return { stdout: viewCount === 1 ? "\n" : `${url}\n` };
      }
      if (file === "gh" && args.includes("create")) {
        throw netFailure({ stderr: "a pull request for branch already exists", code: 1 });
      }
      return {};
    });
    const deps: PublishDeps = { db, git: scriptedGit(() => "").git, net: run };

    const result = await publishTicketBranch(deps, ticketId);

    expect(result).toEqual({ ok: true, value: { url, existing: true } });
    expect(viewCount).toBe(2);
    expect(getTicket(db, ticketId)?.prUrl).toBe(url);
  });

  it("maps a not-installed gh failure to the friendly message and records worktree_failed(pr)", async () => {
    const { db, ticketId } = seedTicket();
    const { run } = scriptedNet((file, args) => {
      if (file === "git") return {};
      if (file === "gh" && args.includes("view")) return { stdout: "\n" };
      if (file === "gh" && args.includes("create")) {
        throw netFailure({ stderr: "spawn gh ENOENT", code: "ENOENT" });
      }
      return {};
    });
    const deps: PublishDeps = { db, git: scriptedGit(() => "").git, net: run };

    const result = await publishTicketBranch(deps, ticketId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/GitHub CLI \(gh\) is not installed/i);
    const failed = events(db, ticketId).find((e) => e.payload.kind === "worktree_failed");
    expect(failed?.payload).toMatchObject({ kind: "worktree_failed", stage: "pr" });
    expect(getTicket(db, ticketId)?.prUrl).toBeNull();
  });

  it("creates a draft PR, persisting pr_url and recording pr_opened", async () => {
    const { db, ticketId } = seedTicket();
    const url = "https://github.com/acme/repo/pull/12";
    const { run, calls } = scriptedNet((file, args) => {
      if (file === "git") return {};
      if (file === "gh" && args.includes("view")) return { stdout: "\n" };
      if (file === "gh" && args.includes("create")) return { stdout: `${url}\n` };
      return {};
    });
    const deps: PublishDeps = { db, git: scriptedGit(() => "").git, net: run };

    const result = await publishTicketBranch(deps, ticketId);

    expect(result).toEqual({ ok: true, value: { url, existing: false } });
    expect(getTicket(db, ticketId)?.prUrl).toBe(url);
    const opened = events(db, ticketId).filter((e) => e.payload.kind === "pr_opened");
    expect(opened).toHaveLength(1);

    // The create call carried --draft, the resolved base, and the composed title/body.
    const create = calls.find((c) => c.file === "gh" && c.args.includes("create"));
    expect(create?.args).toContain("--draft");
    expect(create?.args).toEqual(expect.arrayContaining(["--base", "main"]));
    const titleIdx = create?.args.indexOf("--title") ?? -1;
    expect(create?.args[titleIdx + 1]).toBe("VC-1: Wire the thing");
    const bodyIdx = create?.args.indexOf("--body") ?? -1;
    expect(create?.args[bodyIdx + 1]).toContain("Opened from Volli ticket VC-1.");
    expect(create?.args[bodyIdx + 1]).toContain("Make it work.");
  });

  it("treats a fetch failure as non-fatal and proceeds to push + PR", async () => {
    const { db, ticketId } = seedTicket();
    const url = "https://github.com/acme/repo/pull/3";
    const { run, calls } = scriptedNet((file, args) => {
      if (file === "git" && args[0] === "fetch") {
        throw netFailure({ stderr: "fatal: unable to access origin", code: 1 });
      }
      if (file === "git") return {};
      if (file === "gh" && args.includes("view")) return { stdout: `${url}\n` };
      return {};
    });
    const deps: PublishDeps = { db, git: scriptedGit(() => "").git, net: run };

    const result = await publishTicketBranch(deps, ticketId);

    expect(result).toEqual({ ok: true, value: { url, existing: true } });
    // The push still ran despite the fetch throwing.
    expect(calls.some((c) => c.file === "git" && c.args[0] === "push")).toBe(true);
  });

  it("errs early (no network) when the ticket has no worktree", async () => {
    harness = openTestDb();
    const project = testProject({ id: "p1", ticketPrefix: "VC" });
    insertProject(harness.db, project);
    const ticket = testTicket(project.id, { id: "t1", ticketNumber: 1 });
    insertTicket(harness.db, { ...ticket, prUrl: null });
    const { run, calls } = scriptedNet(() => ({}));
    const deps: PublishDeps = { db: harness.db, git: scriptedGit(() => "").git, net: run };

    const result = await publishTicketBranch(deps, ticket.id);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("commitTicketRemaining", () => {
  it("commits and records worktree_committed on a dirty tree", () => {
    const { db, ticketId } = seedTicket();
    const deps: WorktreeDeps = { db, git: commitGit(" M src/a.ts\n") };

    const result = commitTicketRemaining(deps, ticketId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.message).toBe("chore(VC-1): commit remaining work");
    const committed = events(db, ticketId).find((e) => e.payload.kind === "worktree_committed");
    expect(committed?.payload).toEqual({
      kind: "worktree_committed",
      message: "chore(VC-1): commit remaining work",
    });
  });

  it("records worktree_failed(commit) and errs when the commit fails", () => {
    const { db, ticketId } = seedTicket();
    const git = scriptedGit((args) => {
      if (args[0] === "rev-parse" && args[1] === "--git-dir") return "/repo/.worktrees/VC-1/.git";
      if (args[0] === "status") return " M src/a.ts\n";
      if (args[0] === "add") return "";
      if (args[0] === "commit") throw new GitError("failed", "pre-commit hook: lint failed", args);
      return "";
    }).git;
    const deps: WorktreeDeps = { db, git };

    const result = commitTicketRemaining(deps, ticketId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("pre-commit hook: lint failed");
    const failed = events(db, ticketId).find((e) => e.payload.kind === "worktree_failed");
    expect(failed?.payload).toMatchObject({ kind: "worktree_failed", stage: "commit" });
  });
});
