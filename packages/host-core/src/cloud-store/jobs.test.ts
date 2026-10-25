import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ClaimedJob, JobKind } from "@volli/shared/cloud";

import {
  createInboxWorker,
  type InboxBackend,
  type JobContext,
  type JobExecutor,
} from "../cloud-runner/inbox";
import { sqliteJobJournalStore } from "../cloud-runner/sqlite-stores";
import { openTestDb, type TestDb } from "../db/test-helpers";
import { defaultTrimSettings, runGitCapturingAsync, type BusyWorktreeSite } from "../worktree";
import { createCloudSessionLocationResolver, type CloudLocationFacts } from "./location";
import { createRunnerPathRegistry } from "./paths";
import { registerWorkingCopyJobs, type WorkingCopyJobOptions } from "./jobs";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const TICKET = "00000000-0000-4000-8000-000000000002";
const REPO = "00000000-0000-4000-8000-000000000003";
const COPY = "00000000-0000-4000-8000-000000000004";
const RUNNER = "00000000-0000-4000-8000-000000000005";
const JOB = "00000000-0000-4000-8000-000000000006";
let ctx: TestDb;
let root: string;
let checkout: string;
const context: JobContext = { signal: new AbortController().signal, renew: async () => true };
function git(cwd: string, args: readonly string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  }).trim();
}
function job(kind: JobKind, reason?: string): ClaimedJob {
  const payload =
    kind === "workingCopy.materialize"
      ? { ticketId: TICKET, reason: "session_start" }
      : kind === "workingCopy.refresh"
        ? {}
        : { ticketId: TICKET, workingCopyId: COPY, reason: reason ?? "done" };
  return {
    job: {
      id: JOB,
      kind,
      runnerId: RUNNER,
      projectId: PROJECT,
      ticketId: TICKET,
      sessionId: null,
      workingCopyId: kind === "workingCopy.materialize" ? null : COPY,
      commandId: null,
      payload,
      priority: "normal",
      createdBy: { kind: "volli", reason: "policy" },
      createdAt: 0,
      availableAt: 0,
    },
    lease: { bootId: "boot", attempt: 1, expiresAt: 60_000 },
  } as ClaimedJob;
}
function fixture() {
  const facts: CloudLocationFacts = {
    project: { id: PROJECT, name: "Project" },
    ticketPrefix: "VC",
    ticket: {
      id: TICKET,
      projectId: PROJECT,
      title: "Machine job",
      number: 12,
      checkoutMode: "worktree",
      branch: null,
      baseBranch: "main",
      retentionKeep: false,
      status: "done",
      archivedAt: null,
    },
    primaryRepo: { id: REPO, projectId: PROJECT, baseBranch: "main" },
  };
  const registry = createRunnerPathRegistry(ctx.db, { runnerId: RUNNER });
  registry.checkouts.register({ projectId: PROJECT, projectRepoId: REPO, absPath: checkout });
  const reports = {
    checkout: vi.fn(async () => ({})),
    workingCopy: vi.fn(async () => ({ workingCopyId: COPY })),
  };
  const location = createCloudSessionLocationResolver({
    registry,
    forSession: async () => facts,
    reports,
    gitAsync: runGitCapturingAsync,
    home: root,
  });
  const busy: BusyWorktreeSite[] = [];
  const settings = defaultTrimSettings();
  const options: WorkingCopyJobOptions = {
    registry,
    location,
    gitAsync: runGitCapturingAsync,
    busySites: async () => busy,
    trimSettings: vi.fn(() => settings),
  };
  const executors = new Map<string, JobExecutor>();
  registerWorkingCopyJobs(
    {
      register: (kind, executor) => {
        executors.set(kind, executor);
      },
    },
    options,
  );
  const execute = (kind: JobKind, reason?: string, jobContext = context) =>
    executors.get(kind)!(job(kind, reason), jobContext);
  return { registry, location, facts, options, busy, settings, reports, execute, executors };
}
beforeEach(() => {
  ctx = openTestDb();
  root = mkdtempSync(join(tmpdir(), "volli-cloud-jobs-"));
  checkout = join(root, "checkout");
  mkdirSync(checkout);
  git(checkout, ["init", "-b", "main"]);
  writeFileSync(join(checkout, "README.md"), "initial\n");
  writeFileSync(join(checkout, ".gitignore"), ".env\nnode_modules/\n");
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "-m", "initial"]);
});
afterEach(() => {
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe("Working copy inbox executors", () => {
  it("materializes cloud-only work and returns a path-free branch/head/state outcome", async () => {
    const { execute, registry } = fixture();
    const result = await execute("workingCopy.materialize");
    expect(result).toMatchObject({
      status: "done",
      result: {
        kind: "materialized",
        workingCopy: {
          workingCopyId: COPY,
          branch: "volli/VC-12-machine-job",
          state: "ready",
          headSha: git(checkout, ["rev-parse", "HEAD"]),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(existsSync(registry.workingCopies.pathOf(TICKET, REPO)!)).toBe(true);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  });

  it("reuses the existing trim safety and never deletes preserved configuration", async () => {
    const { execute, registry, facts, busy, settings, reports } = fixture();
    await execute("workingCopy.materialize");
    const path = registry.workingCopies.pathOf(TICKET, REPO)!;
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", "cache"), "cache");
    writeFileSync(join(path, ".env"), "LOCAL=1\n");
    facts.ticket!.retentionKeep = true;
    expect(await execute("workingCopy.trim")).toMatchObject({
      status: "done",
      result: { kind: "skipped" },
    });
    facts.ticket!.retentionKeep = false;
    settings.trimOnFinish = false;
    expect(await execute("workingCopy.trim")).toMatchObject({
      status: "done",
      result: { reason: "automatic trim is off" },
    });
    settings.trimOnFinish = true;
    busy.push({ directory: path, surface: "terminal" });
    expect(await execute("workingCopy.trim")).toMatchObject({
      status: "done",
      result: { kind: "skipped" },
    });
    busy.length = 0;
    writeFileSync(join(path, "README.md"), "dirty\n");
    expect(await execute("workingCopy.trim")).toMatchObject({
      status: "done",
      result: { kind: "skipped" },
    });
    git(path, ["restore", "README.md"]);
    expect(await execute("workingCopy.trim")).toMatchObject({
      status: "done",
      result: { kind: "trimmed", entries: 1 },
    });
    expect(existsSync(join(path, "node_modules"))).toBe(false);
    expect(existsSync(join(path, ".env"))).toBe(true);
    expect(reports.workingCopy).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "trimmed", branch: "volli/VC-12-machine-job" }),
    );
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM ticket_events").get()).toEqual({ n: 0 });
  });

  it("refuses unfenced/wrong-runner/wrong-copy work before touching its files", async () => {
    const { executors, execute, registry } = fixture();
    await execute("workingCopy.materialize");
    const path = registry.workingCopies.pathOf(TICKET, REPO)!;
    const wrongRunner = job("workingCopy.reclaim", "requested");
    wrongRunner.job.runnerId = "other-runner" as typeof wrongRunner.job.runnerId;
    expect(await executors.get("workingCopy.reclaim")!(wrongRunner, context)).toMatchObject({
      status: "failed",
      code: "not_your_runner",
    });
    const wrongCopy = job("workingCopy.reclaim", "requested");
    wrongCopy.job.workingCopyId = "other-copy" as typeof wrongCopy.job.workingCopyId;
    expect(await executors.get("workingCopy.reclaim")!(wrongCopy, context)).toMatchObject({
      status: "failed",
      code: "invalid_job_payload",
    });
    expect(
      await execute("workingCopy.reclaim", "requested", { ...context, renew: async () => false }),
    ).toMatchObject({ status: "failed", code: "lease_lost" });
    expect(existsSync(path)).toBe(true);
  });

  it("reclaims only with policy approval and full dirty checks; refresh/recreate retain branch/head after retitle", async () => {
    const { execute, registry, facts, options, reports } = fixture();
    await execute("workingCopy.materialize");
    const path = registry.workingCopies.pathOf(TICKET, REPO)!;
    expect(await execute("workingCopy.reclaim", "retention")).toMatchObject({
      status: "done",
      result: { kind: "skipped" },
    });
    options.retentionReclaimAllowed = async () => true;
    writeFileSync(join(path, "precious.txt"), "work\n");
    expect(await execute("workingCopy.reclaim", "retention")).toMatchObject({
      status: "done",
      result: { kind: "skipped" },
    });
    rmSync(join(path, "precious.txt"));
    const sha = git(path, ["rev-parse", "HEAD"]);
    expect(await execute("workingCopy.reclaim", "retention")).toMatchObject({
      status: "done",
      result: {
        kind: "reclaimed",
        workingCopy: {
          state: "reclaimed",
          branch: "volli/VC-12-machine-job",
          headSha: sha,
        },
      },
    });
    expect(existsSync(path)).toBe(false);
    expect(await execute("workingCopy.refresh")).toMatchObject({
      status: "done",
      result: {
        kind: "refreshed",
        workingCopy: { branch: "volli/VC-12-machine-job", headSha: sha },
      },
    });
    facts.ticket!.title = "Retitled after reclaim";
    await execute("workingCopy.materialize");
    expect(git(path, ["branch", "--show-current"])).toBe("volli/VC-12-machine-job");
    expect(reports.workingCopy).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "ready", headSha: sha }),
    );
  });

  it("replays a journaled outcome under a new lease after restart without executing twice", async () => {
    const { execute, options, registry } = fixture();
    await execute("workingCopy.materialize");
    const path = registry.workingCopies.pathOf(TICKET, REPO)!;
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", "cache"), "cache");
    const claimed = job("workingCopy.trim");
    const journal = sqliteJobJournalStore(ctx.db);
    let reportAttempted!: () => void;
    const reported = new Promise<void>((resolve) => {
      reportAttempted = resolve;
    });
    const queue = [[claimed]];
    const backend: InboxBackend = {
      claim: async () => queue.shift() ?? [],
      renew: async () => ({ ok: true, lease: claimed.lease }),
      complete: async ({ jobId }) => {
        expect(journal.get(jobId)?.outcome?.status).toBe("done");
        reportAttempted();
        throw new Error("offline");
      },
    };
    const makeWorker = (inboxBackend: InboxBackend) =>
      createInboxWorker({
        backend: inboxBackend,
        journal,
        bootId: "boot",
        // No wall-clock timers in this restart proof.
        setTimer: () => ({}),
        clearTimer: () => {},
        onError: () => {},
      });
    const first = makeWorker(backend);
    registerWorkingCopyJobs(first, options);
    await first.start();
    await reported;
    first.stop();
    expect(journal.get(JOB)?.state).toBe("done");
    expect(options.trimSettings).toHaveBeenCalledTimes(1);
    const released = { ...claimed, lease: { ...claimed.lease, attempt: 2 } };
    const nextQueue = [[released]];
    const second = makeWorker({ ...backend, claim: async () => nextQueue.shift() ?? [] });
    registerWorkingCopyJobs(second, options);
    await second.start();
    second.stop();
    expect(journal.get(JOB)?.lease.attempt).toBe(2);
    expect(options.trimSettings).toHaveBeenCalledTimes(1);
    expect(existsSync(join(path, "node_modules"))).toBe(false);
  });
});

it("never trims or reclaims main-checkout copies, while refresh still reports their metadata", async () => {
  const { facts, registry, execute, reports } = fixture();
  facts.ticket!.checkoutMode = "main_checkout";
  expect(await execute("workingCopy.materialize")).toMatchObject({ status: "done" });
  expect(registry.workingCopies.get(TICKET, REPO)?.kind).toBe("main_checkout");
  mkdirSync(join(checkout, "node_modules"));
  writeFileSync(join(checkout, "node_modules", "keep"), "do not trim");
  for (const [kind, reason] of [
    ["workingCopy.trim", "done"],
    ["workingCopy.reclaim", "requested"],
  ] as const) {
    expect(await execute(kind, reason)).toMatchObject({
      status: "done",
      result: { kind: "skipped", reason: "main checkout is never trimmed or reclaimed" },
    });
  }
  expect(existsSync(join(checkout, "node_modules", "keep"))).toBe(true);
  expect(await execute("workingCopy.refresh")).toMatchObject({ status: "done" });
  expect(reports.workingCopy).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "main_checkout", state: "ready", branch: "main" }),
  );
});

it("keeps machine exception and refusal paths out of backend outcomes", async () => {
  const f = fixture();
  const localPath = join(root, "private-checkout");
  const materialize = vi
    .spyOn(f.location, "materialize")
    .mockRejectedValueOnce(new Error(`Could not prepare ${localPath}`));
  const failure = await f.execute("workingCopy.materialize");
  expect(failure).toMatchObject({ status: "failed", code: "working_copy_failed" });
  expect(JSON.stringify(failure)).not.toContain(root);
  materialize.mockRestore();
  await f.execute("workingCopy.materialize");
  const path = f.registry.workingCopies.pathOf(TICKET, REPO)!;
  writeFileSync(join(path, "README.md"), "dirty\n");
  for (const [kind, reason] of [
    ["workingCopy.trim", "done"],
    ["workingCopy.reclaim", "requested"],
  ] as const) {
    const refused = await f.execute(kind, reason);
    expect(refused).toMatchObject({ status: "done", result: { kind: "skipped" } });
    expect(JSON.stringify(refused)).not.toContain(root);
  }
  vi.spyOn(f.location, "factsFor").mockRejectedValueOnce(new Error(`Unreadable ${localPath}`));
  const unreadable = await f.execute("workingCopy.refresh");
  expect(unreadable).toMatchObject({ status: "failed", code: "working_copy_failed" });
  expect(JSON.stringify(unreadable)).not.toContain(root);
});
