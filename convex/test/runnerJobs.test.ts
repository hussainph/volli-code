import { convexTest } from "convex-test";
import type { GenericMutationCtx } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  JOB_CLAIM_MAX,
  JOB_LEASE_MAX_MS,
  JOB_LEASE_MS,
  JOB_RESULT_MAX_CHARS,
  RUNNER_TOKEN_ISSUER,
  SESSION_INTERRUPT_FORMAT,
  TERMINAL_JOB_TTL_MS,
  newId,
  type Actor,
  type JobKind,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { DataModel, Doc } from "../functions/_generated/dataModel.js";
import {
  JOB_MAX_ATTEMPTS,
  cancelJob,
  enqueueJob,
  retryDelayMs,
  tryEnqueueJob,
  type JobDraft,
} from "../functions/lib/jobs";
import schema from "../functions/schema";

const modules = import.meta.glob("../functions/**/*.ts");

type Ctx = GenericMutationCtx<DataModel>;
const setup = () => convexTest(schema, modules);
type T = ReturnType<typeof setup>;

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

afterEach(() => {
  vi.useRealTimers();
});

/** `value` is `target`, give or take the backend clock's per-transaction tick. */
function near(value: number, target: number) {
  expect(value).toBeGreaterThanOrEqual(target);
  expect(value).toBeLessThan(target + 1_000);
}

function code(value: string) {
  return expect.objectContaining({ data: expect.objectContaining({ code: value }) });
}

interface World {
  t: T;
  ownerUserId: string;
  workspaceId: string;
  projectId: string;
  ticketId: string;
  runnerId: string;
  /** A runner of someone else. */
  otherRunnerId: string;
  otherUserId: string;
}

async function seedRunner(ctx: Ctx, ownerUserId: string, name: string): Promise<string> {
  const id = newId("runner");
  await ctx.db.insert("runners", {
    id,
    ownerUserId,
    kind: "mac",
    name,
    status: "online",
    statusReason: null,
    statusChangedAt: 0,
    version: "0.3.0",
    platform: { os: "darwin", distro: null, kernel: null, arch: "arm64", glibc: null },
    capabilities: {},
    installMode: "app",
    linkedVia: "desktop",
    linkedAt: 0,
    autoUpdate: { enabled: true, channel: "stable", pinnedVersion: null },
    update: null,
    revokedAt: null,
    createdAt: 0,
  });
  return id;
}

/** A runner serves only an owner whose account is active. */
async function seedUser(ctx: Ctx, userId: string) {
  await ctx.db.insert("users", {
    id: userId,
    primaryEmail: null,
    emailVerified: false,
    displayName: "Person",
    avatarKey: null,
    status: "active",
    deletionRequestedAt: null,
    purgeAfter: null,
    trialSeededWorkspaceId: null,
    createdAt: 0,
    lastSeenAt: 0,
  });
}

async function seedMember(ctx: Ctx, workspaceId: string, userId: string) {
  await ctx.db.insert("workspaceMembers", {
    id: newId("member"),
    workspaceId,
    userId,
    role: "member",
    status: "active",
    billingTier: "free",
    joinedAt: 0,
    suspendedAt: null,
    leftAt: null,
    invitedByUserId: null,
  });
}

async function seedTicket(ctx: Ctx, projectId: string, ticketId: string, userId: string) {
  await ctx.db.insert("tickets", {
    id: ticketId,
    projectId,
    number: 1,
    title: "Ticket",
    status: "todo",
    priority: "medium",
    position: "a0",
    labelIds: [],
    assigneeUserId: null,
    checkoutMode: "worktree",
    preferredHarnessId: "pi",
    branch: null,
    baseBranch: null,
    pullRequests: [],
    retentionKeep: false,
    placeRunnerId: null,
    createdBy: { kind: "person", userId },
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    deletedAt: null,
    purgeAfter: null,
  });
}

async function world(): Promise<World> {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const t = setup();
  const ownerUserId = newId("user");
  const otherUserId = newId("user");
  const ids = await t.run(async (ctx) => {
    const workspaceId = newId("workspace");
    await ctx.db.insert("workspaces", {
      id: workspaceId,
      name: "Acme",
      slug: `acme-${workspaceId.slice(0, 8)}`,
      iconKey: null,
      createdByUserId: ownerUserId,
      planKey: "free",
      activeMemberCount: 2,
      createdAt: 0,
      deletedAt: null,
      purgeAfter: null,
    });
    await seedMember(ctx, workspaceId, ownerUserId);
    await seedMember(ctx, workspaceId, otherUserId);
    await seedUser(ctx, ownerUserId);
    await seedUser(ctx, otherUserId);
    const projectId = newId("project");
    await ctx.db.insert("projects", {
      id: projectId,
      workspaceId,
      name: "Volli",
      description: "",
      iconKey: null,
      colorIndex: 0,
      ticketPrefix: "VC",
      origin: "github",
      shipBehaviour: "pr",
      customShipPrompt: null,
      coAuthorDefault: true,
      countsTowardCap: true,
      createdByUserId: ownerUserId,
      createdAt: 0,
      updatedAt: 0,
      archivedAt: null,
      deletedAt: null,
      purgeAfter: null,
    });
    const ticketId = newId("ticket");
    await seedTicket(ctx, projectId, ticketId, ownerUserId);
    return {
      workspaceId,
      projectId,
      ticketId,
      runnerId: await seedRunner(ctx, ownerUserId, "hp-mac"),
      otherRunnerId: await seedRunner(ctx, otherUserId, "ana-mac"),
    };
  });
  return { t, ownerUserId, otherUserId, ...ids };
}

const person = (userId: string): Actor => ({ kind: "person", userId }) as Actor;

function materialize(w: World, overrides: Partial<JobDraft> = {}): JobDraft {
  return {
    runnerId: w.runnerId,
    kind: "workingCopy.materialize",
    projectId: w.projectId,
    ticketId: w.ticketId,
    payload: { ticketId: w.ticketId, reason: "session_start" },
    createdBy: person(w.ownerUserId),
    onBehalfOf: w.ownerUserId,
    ...overrides,
  } as JobDraft;
}

async function enqueue(w: World, draft: JobDraft) {
  return w.t.run((ctx) => enqueueJob(ctx, draft));
}

async function job(w: World, jobId: string): Promise<Doc<"runnerJobs"> | null> {
  return w.t.run((ctx) =>
    ctx.db
      .query("runnerJobs")
      .withIndex("by_uuid", (q) => q.eq("id", jobId))
      .unique(),
  );
}

/** The runner's owner leaves the Workspace. */
async function leave(w: World) {
  await w.t.run(async (ctx) => {
    const member = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", w.workspaceId).eq("userId", w.ownerUserId),
      )
      .unique();
    await ctx.db.patch(member!._id, { status: "left", leftAt: T0 });
  });
}

function runner(w: World, runnerId = w.runnerId) {
  return w.t.withIdentity({ subject: `runner:${runnerId}`, issuer: RUNNER_TOKEN_ISSUER });
}

const BOOT = "b0000000-0000-4000-8000-000000000001";
const BOOT2 = "b0000000-0000-4000-8000-000000000002";
const OTHER_BOOT = "b0000000-0000-4000-8000-000000000009";

async function claim(
  w: World,
  args: { bootId?: string; max?: number } = {},
  runnerId = w.runnerId,
) {
  return runner(w, runnerId).mutation(api.runnerJobs.claim, { bootId: BOOT, ...args });
}

function done(w: World, jobId: string, attempt = 1, bootId = BOOT, result: unknown = { ok: true }) {
  return runner(w).mutation(api.runnerJobs.complete, {
    jobId,
    bootId,
    attempt,
    outcome: { status: "done", result },
  });
}

function failed(w: World, jobId: string, attempt: number, retryable: boolean, bootId = BOOT) {
  return runner(w).mutation(api.runnerJobs.complete, {
    jobId,
    bootId,
    attempt,
    outcome: { status: "failed", code: "git_failed", detail: "exit 128", retryable },
  });
}

describe("enqueueJob", () => {
  test("queues a job once; a replay with the same content returns it, another job under its id is refused", async () => {
    const w = await world();
    const first = await enqueue(w, materialize(w));
    expect(first.created).toBe(true);
    const row = await job(w, first.jobId);
    expect(row).toMatchObject({
      runnerId: w.runnerId,
      kind: "workingCopy.materialize",
      status: "queued",
      priority: "normal",
      rank: 1,
      availableAt: T0,
      lease: null,
      failure: null,
      createdAt: T0,
    });
    // Key order does not make a replay different.
    await expect(
      enqueue(
        w,
        materialize(w, {
          id: first.jobId,
          payload: { reason: "session_start", ticketId: w.ticketId },
        }),
      ),
    ).resolves.toEqual({ jobId: first.jobId, created: false });
    await expect(
      enqueue(
        w,
        materialize(w, {
          id: first.jobId,
          payload: { ticketId: w.ticketId, reason: "checkout_mode_changed" },
        }),
      ),
    ).rejects.toThrow(code("id_taken"));
  });

  test("a job that carries a command takes the command's id", async () => {
    const w = await world();
    const commandId = newId("command");
    const sessionId = newId("session");
    const draft: JobDraft = {
      runnerId: w.runnerId,
      kind: "session.command",
      projectId: w.projectId,
      sessionId,
      commandId,
      payload: {
        format: SESSION_INTERRUPT_FORMAT,
        reason: "ticket_left_active_columns",
        from: "doing",
        to: "done",
      },
      priority: "urgent",
      createdBy: { kind: "volli", reason: "supervision", onBehalfOf: w.ownerUserId } as Actor,
      onBehalfOf: w.ownerUserId,
    } as JobDraft;
    await expect(enqueue(w, draft)).resolves.toEqual({ jobId: commandId, created: true });
    expect(await job(w, commandId)).toMatchObject({ rank: 0, commandId, sessionId });
    await expect(enqueue(w, { ...draft, id: newId("job") } as JobDraft)).rejects.toThrow(
      code("invalid_job"),
    );
  });

  test("checks ids and payloads with the shared codecs", async () => {
    const w = await world();
    await expect(enqueue(w, materialize(w, { runnerId: "hp-mac" }))).rejects.toThrow(
      code("invalid_job"),
    );
    await expect(
      enqueue(w, materialize(w, { payload: { ticketId: w.ticketId, reason: "whim" } } as never)),
    ).rejects.toThrow(code("invalid_job"));
  });

  test("the ids a payload names are the job's own, and kinds name what they act on", async () => {
    const w = await world();
    await expect(enqueue(w, materialize(w, { ticketId: newId("ticket") }))).rejects.toThrow(
      code("invalid_job"),
    );
    const copyId = newId("workingCopy");
    const trim = (overrides: Partial<JobDraft>) =>
      ({
        runnerId: w.runnerId,
        kind: "workingCopy.trim",
        projectId: w.projectId,
        ticketId: w.ticketId,
        workingCopyId: copyId,
        payload: { ticketId: w.ticketId, workingCopyId: copyId, reason: "done" },
        createdBy: person(w.ownerUserId),
        onBehalfOf: w.ownerUserId,
        ...overrides,
      }) as JobDraft;
    await expect(enqueue(w, trim({ workingCopyId: newId("workingCopy") }))).rejects.toThrow(
      code("invalid_job"),
    );
    const refresh = trim({ kind: "workingCopy.refresh", workingCopyId: null, payload: {} });
    await expect(enqueue(w, refresh)).rejects.toThrow(code("invalid_job"));
    const start = {
      runnerId: w.runnerId,
      kind: "session.start",
      projectId: w.projectId,
      payload: {},
      createdBy: person(w.ownerUserId),
      onBehalfOf: w.ownerUserId,
    } as JobDraft;
    await expect(enqueue(w, start)).rejects.toThrow(code("invalid_job"));
  });

  test("a runner only runs its owner's work, in projects its owner is a member of", async () => {
    const w = await world();
    await expect(enqueue(w, materialize(w, { onBehalfOf: w.otherUserId }))).rejects.toThrow(
      code("not_your_runner"),
    );
    await expect(enqueue(w, materialize(w, { runnerId: newId("runner") }))).rejects.toThrow(
      code("runner_unavailable"),
    );
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("runners")
        .withIndex("by_uuid", (q) => q.eq("id", w.otherRunnerId))
        .unique();
      await ctx.db.patch(row!._id, { revokedAt: T0 });
    });
    await expect(
      enqueue(w, materialize(w, { runnerId: w.otherRunnerId, onBehalfOf: w.otherUserId })),
    ).rejects.toThrow(code("runner_unavailable"));
    // An outsider's runner: they own it, but are not in this Workspace.
    const outsider = newId("user");
    const outsiderRunner = await w.t.run((ctx) => seedRunner(ctx, outsider, "outside"));
    await expect(
      enqueue(w, materialize(w, { runnerId: outsiderRunner, onBehalfOf: outsider })),
    ).rejects.toThrow(code("not_a_member"));
    // A deleted project takes no work at all.
    await w.t.run(async (ctx) => {
      const project = await ctx.db
        .query("projects")
        .withIndex("by_uuid", (q) => q.eq("id", w.projectId))
        .unique();
      await ctx.db.patch(project!._id, { deletedAt: T0 });
    });
    await expect(enqueue(w, materialize(w))).rejects.toThrow(code("not_a_member"));
  });

  test("a deleted Workspace or a missing project takes no work", async () => {
    const w = await world();
    const notice = (projectId: string) =>
      ({
        runnerId: w.runnerId,
        kind: "session.notice",
        projectId,
        sessionId: newId("session"),
        payload: {},
        createdBy: person(w.ownerUserId),
        onBehalfOf: w.ownerUserId,
      }) as JobDraft;
    await expect(enqueue(w, notice(newId("project")))).rejects.toThrow(code("not_a_member"));
    await w.t.run(async (ctx) => {
      const workspace = await ctx.db
        .query("workspaces")
        .withIndex("by_uuid", (q) => q.eq("id", w.workspaceId))
        .unique();
      await ctx.db.patch(workspace!._id, { deletedAt: T0 });
    });
    await expect(enqueue(w, materialize(w))).rejects.toThrow(code("not_a_member"));
  });

  test("Working copy housekeeping is the runner owner's: it names a Working copy on that runner", async () => {
    const w = await world();
    const copyId = newId("workingCopy");
    await w.t.run(async (ctx) => {
      await ctx.db.insert("workingCopies", {
        id: copyId,
        ticketId: w.ticketId,
        projectId: w.projectId,
        runnerId: w.runnerId,
        projectRepoId: newId("projectRepo"),
        kind: "worktree",
        state: "ready",
        failure: null,
        branch: "volli/VC-1",
        baseBranch: "main",
        headSha: null,
        upstreamSha: null,
        ahead: 0,
        behind: 0,
        dirty: { files: 0, insertions: 0, deletions: 0, untracked: 0, truncated: false },
        changeSetRevision: null,
        firstRun: { copy: "done", setup: "done" },
        setupRecipeSha: null,
        setupOutcome: null,
        lastResumeAt: null,
        lastResumeBootId: null,
        reportedAt: 0,
        createdAt: 0,
      });
    });
    const trim = (runnerId: string) =>
      ({
        runnerId,
        kind: "workingCopy.trim",
        projectId: w.projectId,
        ticketId: w.ticketId,
        workingCopyId: copyId,
        payload: { ticketId: w.ticketId, workingCopyId: copyId, reason: "done" },
        // A teammate's Done move trims the owner's Working copy.
        createdBy: person(w.otherUserId),
        onBehalfOf: null,
      }) as JobDraft;
    await expect(enqueue(w, trim(w.otherRunnerId))).rejects.toThrow(code("not_your_runner"));
    // Naming whose work it is does not let a job act on a copy held elsewhere.
    await expect(
      enqueue(w, { ...trim(w.otherRunnerId), onBehalfOf: w.otherUserId } as JobDraft),
    ).rejects.toThrow(code("not_your_runner"));
    const otherTicket = newId("ticket");
    await w.t.run((ctx) => seedTicket(ctx, w.projectId, otherTicket, w.ownerUserId));
    await expect(
      enqueue(w, {
        ...trim(w.runnerId),
        ticketId: otherTicket,
        payload: { ticketId: otherTicket, workingCopyId: copyId, reason: "done" },
      } as JobDraft),
    ).rejects.toThrow(code("invalid_job"));
    await expect(enqueue(w, trim(w.runnerId))).resolves.toMatchObject({ created: true });
    // Anything else must say whose work it is.
    await expect(enqueue(w, materialize(w, { onBehalfOf: null }))).rejects.toThrow(
      code("invalid_job"),
    );
    const missing = newId("workingCopy");
    await expect(
      enqueue(w, {
        ...trim(w.runnerId),
        workingCopyId: missing,
        payload: { ticketId: w.ticketId, workingCopyId: missing, reason: "done" },
      } as JobDraft),
    ).rejects.toThrow(code("not_your_runner"));
  });

  test("a Session's jobs go to the runner holding its claim", async () => {
    const w = await world();
    const sessionId = newId("session");
    await w.t.run((ctx) =>
      ctx.db.insert("sessionIntake", {
        sessionId,
        claim: { runnerId: w.otherRunnerId, generation: 1 },
        acceptedThrough: 0,
        lastEventId: null,
        lastAcceptedAt: null,
        state: "active",
      }),
    );
    const notice = {
      runnerId: w.runnerId,
      kind: "session.notice",
      projectId: w.projectId,
      sessionId,
      payload: { text: "hi" },
      createdBy: person(w.ownerUserId),
      onBehalfOf: w.ownerUserId,
    } as JobDraft;
    await expect(enqueue(w, notice)).rejects.toThrow(code("wrong_runner"));
    await expect(
      enqueue(w, { ...notice, runnerId: w.otherRunnerId, onBehalfOf: w.otherUserId } as JobDraft),
    ).resolves.toMatchObject({ created: true });
  });

  test("refuses unknown kinds, and the ticket and session a job names must be in its project", async () => {
    const w = await world();
    await expect(enqueue(w, materialize(w, { kind: "relay.open" as JobKind }))).rejects.toThrow(
      code("invalid_job"),
    );
    const stranger = newId("ticket");
    await expect(
      enqueue(
        w,
        materialize(w, {
          ticketId: stranger,
          payload: { ticketId: stranger, reason: "session_start" },
        }),
      ),
    ).rejects.toThrow(code("invalid_job"));
    const sessionId = newId("session");
    await w.t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        id: sessionId,
        projectId: newId("project"),
        ticketId: null,
        role: "project",
        parentSessionId: null,
        ownerUserId: w.ownerUserId,
        origin: { kind: "user" },
        title: null,
        visibility: "private",
        visibilityReason: "adhoc",
        sharedAt: null,
        status: "open",
        turnActive: false,
        lastTurnOutcome: null,
        signal: null,
        stopped: null,
        needsUser: false,
        attentionCount: 0,
        placeRunnerId: w.runnerId,
        model: null,
        usageTotals: {},
        createdAt: 0,
        lastActivityAt: 0,
        deletedAt: null,
        purgeAfter: null,
      });
    });
    await expect(
      enqueue(w, {
        runnerId: w.runnerId,
        kind: "session.notice",
        projectId: w.projectId,
        sessionId,
        payload: {},
        createdBy: person(w.ownerUserId),
        onBehalfOf: w.ownerUserId,
      } as JobDraft),
    ).rejects.toThrow(code("invalid_job"));
  });

  test("an armed Automation run is its armer's work", async () => {
    const w = await world();
    const run = (armedByUserId: string) =>
      ({
        runnerId: w.runnerId,
        kind: "automation.run",
        projectId: w.projectId,
        ticketId: w.ticketId,
        payload: {
          trigger: "arrival",
          automationId: newId("automation"),
          ticketId: w.ticketId,
          from: "todo",
          status: "doing",
          origin: "armed",
          armedByUserId,
        },
        availableAt: T0 + 10_000,
        createdBy: person(w.otherUserId),
        onBehalfOf: w.ownerUserId,
      }) as JobDraft;
    await expect(enqueue(w, run(w.otherUserId))).rejects.toThrow(code("invalid_job"));
    await expect(enqueue(w, run(w.ownerUserId))).resolves.toMatchObject({ created: true });
  });

  test("tryEnqueueJob returns a routing refusal instead of throwing it", async () => {
    const w = await world();
    await expect(
      w.t.run((ctx) => tryEnqueueJob(ctx, materialize(w, { onBehalfOf: w.otherUserId }))),
    ).resolves.toEqual({
      refused: "not_your_runner",
      message: "A runner only runs its owner's work.",
    });
    await expect(
      w.t.run((ctx) => tryEnqueueJob(ctx, materialize(w, { runnerId: "nope" }))),
    ).rejects.toThrow(code("invalid_job"));
  });
});

describe("runnerJobs.claim", () => {
  test("only a runner may claim, and only its own jobs", async () => {
    const w = await world();
    await enqueue(w, materialize(w));
    await expect(
      w.t
        .withIdentity({ subject: "user:alice", issuer: "https://issuer.test" })
        .mutation(api.runnerJobs.claim, { bootId: BOOT }),
    ).rejects.toThrow(code("not_a_runner"));
    await expect(claim(w, {}, w.otherRunnerId)).resolves.toEqual([]);
    await expect(claim(w, { bootId: "" })).rejects.toThrow(code("invalid_request"));
    await expect(claim(w, { bootId: "x".repeat(201) })).rejects.toThrow(code("invalid_request"));
  });

  test("leases ready jobs urgent first, then oldest; later jobs wait; a claim takes at most max", async () => {
    const w = await world();
    const later = await enqueue(w, materialize(w, { availableAt: T0 + 30_000 }));
    vi.setSystemTime(T0 + 1);
    const normal = await enqueue(w, materialize(w));
    vi.setSystemTime(T0 + 2);
    const urgent = await enqueue(w, materialize(w, { priority: "urgent" }));
    const older = await enqueue(w, materialize(w, { availableAt: T0 - 5 }));

    const first = await claim(w, { max: 2 });
    expect(first.map((c) => c.job.id)).toEqual([urgent.jobId, older.jobId]);
    expect(first[0]).toEqual({
      job: expect.objectContaining({
        id: urgent.jobId,
        runnerId: w.runnerId,
        kind: "workingCopy.materialize",
        projectId: w.projectId,
        ticketId: w.ticketId,
        sessionId: null,
        workingCopyId: null,
        commandId: null,
        payload: { ticketId: w.ticketId, reason: "session_start" },
        priority: "urgent",
        createdBy: person(w.ownerUserId),
      }),
      lease: { bootId: BOOT, attempt: 1, expiresAt: expect.any(Number) },
    });
    expect(first[0]!.lease.expiresAt).toBeGreaterThanOrEqual(T0 + 2 + JOB_LEASE_MS);
    expect(first[0]!.lease.expiresAt).toBeLessThan(T0 + 2 + JOB_LEASE_MS + 1_000);
    expect((await claim(w)).map((c) => c.job.id)).toEqual([normal.jobId]);
    await expect(claim(w)).resolves.toEqual([]);
    vi.setSystemTime(T0 + 30_000);
    expect((await claim(w, { max: 1000 })).map((c) => c.job.id)).toEqual([later.jobId]);
    expect((await job(w, later.jobId))!.status).toBe("leased");
  });

  test("caps a claim at JOB_CLAIM_MAX", async () => {
    const w = await world();
    for (let index = 0; index < JOB_CLAIM_MAX + 1; index += 1) await enqueue(w, materialize(w));
    expect(await claim(w, { max: 0 })).toHaveLength(1);
    expect(await claim(w)).toHaveLength(JOB_CLAIM_MAX);
  });

  test("takes back the jobs an earlier boot held, under the next attempt", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await claim(w);
    // The same boot does not get its own live lease again.
    await expect(claim(w)).resolves.toEqual([]);
    const after = await claim(w, { bootId: BOOT2 });
    expect(after.map((c) => [c.lease.bootId, c.lease.attempt])).toEqual([[BOOT2, 2]]);
    // The old boot's lease is fenced; the new one completes.
    await expect(done(w, jobId, 1, BOOT)).resolves.toEqual({ ack: "superseded", reason: "fenced" });
    await expect(done(w, jobId, 2, BOOT2)).resolves.toEqual({ ack: "recorded", status: "done" });
  });

  test("this boot's own lease that ran out waits for its scheduled check and backoff", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    const [held] = await claim(w);
    vi.setSystemTime(held!.lease.expiresAt);
    await expect(claim(w)).resolves.toEqual([]);
    await w.t.mutation(internal.runnerJobs.expireLease, { jobId, attempt: 1 });
    vi.setSystemTime((await job(w, jobId))!.availableAt);
    expect((await claim(w)).map((c) => c.lease.attempt)).toEqual([2]);
  });

  test("cancels, rather than hands out, work its owner may no longer do", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    const second = await enqueue(w, materialize(w));
    await leave(w);
    await expect(claim(w)).resolves.toEqual([]);
    for (const id of [jobId, second.jobId]) {
      const row = (await job(w, id))!;
      expect(row).toMatchObject({
        status: "cancelled",
        failure: expect.objectContaining({ code: "not_a_member", by: "backend", attempt: 0 }),
      });
      expect(row.expiresAt).toBe(row.completedAt! + TERMINAL_JOB_TTL_MS);
    }
  });
});

describe("lease expiry", () => {
  test("a lease that runs out returns the job to the queue after a backoff; its late completion still counts", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await claim(w);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    const row = (await job(w, jobId))!;
    expect(row.status).toBe("queued");
    expect(row.failure).toEqual({
      attempt: 1,
      code: "lease_expired",
      detail: null,
      retryable: true,
      by: "backend",
      at: expect.any(Number),
    });
    expect(row.availableAt).toBe(row.failure!.at + retryDelayMs(1));
    // Nothing replaced the lease, so the runner that held it may still finish.
    await expect(done(w, jobId)).resolves.toEqual({ ack: "recorded", status: "done" });
    await expect(done(w, jobId)).resolves.toEqual({ ack: "duplicate", status: "done" });
  });

  test("a renewed lease moves its check; a lease already replaced leaves nothing to do", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await claim(w);
    const renewed = await runner(w).mutation(api.runnerJobs.renew, {
      jobId,
      bootId: BOOT,
      attempt: 1,
      extendMs: 10 * 60_000,
    });
    if (!renewed.ok) throw new Error("renew refused");
    vi.setSystemTime(T0 + JOB_LEASE_MS + 1_000);
    await w.t.mutation(internal.runnerJobs.expireLease, { jobId, attempt: 1 });
    expect((await job(w, jobId))!.status).toBe("leased");
    // A stale check for another attempt, or for a job that is gone, is a no-op.
    await w.t.mutation(internal.runnerJobs.expireLease, { jobId, attempt: 7 });
    await w.t.mutation(internal.runnerJobs.expireLease, { jobId: newId("job"), attempt: 1 });
    expect((await job(w, jobId))!.lease!.expiresAt).toBe(renewed.lease.expiresAt);
    // The moved check fires at the new expiry and finds the lease run out.
    vi.setSystemTime(renewed.lease.expiresAt);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await job(w, jobId))!.status).toBe("queued");
  });

  test("the last lease running out dead-letters the job as expired; a late completion is still recorded", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    for (let attempt = 1; attempt <= JOB_MAX_ATTEMPTS; attempt += 1) {
      const [claimed] = await claim(w);
      expect(claimed!.lease.attempt).toBe(attempt);
      vi.setSystemTime(claimed!.lease.expiresAt);
      await w.t.mutation(internal.runnerJobs.expireLease, { jobId, attempt });
      vi.setSystemTime((await job(w, jobId))!.availableAt);
    }
    const row = (await job(w, jobId))!;
    expect(row).toMatchObject({
      status: "expired",
      failure: expect.objectContaining({ code: "lease_expired", retryable: false, attempt: 5 }),
    });
    expect(row.expiresAt).toBe(row.completedAt! + TERMINAL_JOB_TTL_MS);
    await expect(claim(w)).resolves.toEqual([]);
    await expect(done(w, jobId, JOB_MAX_ATTEMPTS)).resolves.toEqual({
      ack: "recorded",
      status: "done",
    });
  });

  test("a claim dead-letters an earlier boot's job that was on its last attempt", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", jobId))
        .unique();
      await ctx.db.patch(row!._id, {
        status: "leased",
        lease: { bootId: OTHER_BOOT, attempt: JOB_MAX_ATTEMPTS, expiresAt: T0 + JOB_LEASE_MS },
      });
    });
    await expect(claim(w)).resolves.toEqual([]);
    expect((await job(w, jobId))!.status).toBe("expired");
  });
});

describe("runnerJobs.renew", () => {
  test("extends the current lease, bounded; says why when the runner lost the job", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await claim(w);
    const renew = (args: { attempt?: number; bootId?: string; extendMs?: number; id?: string }) =>
      runner(w).mutation(api.runnerJobs.renew, {
        jobId: args.id ?? jobId,
        bootId: args.bootId ?? BOOT,
        attempt: args.attempt ?? 1,
        ...(args.extendMs === undefined ? {} : { extendMs: args.extendMs }),
      });
    const extended = async (extendMs?: number) => {
      const reply = await renew(extendMs === undefined ? {} : { extendMs });
      if (!reply.ok) throw new Error("renew refused");
      expect(reply.lease).toMatchObject({ bootId: BOOT, attempt: 1 });
      expect((await job(w, jobId))!.lease).toEqual(reply.lease);
      return reply.lease.expiresAt - T0;
    };
    near(await extended(), JOB_LEASE_MS);
    near(await extended(24 * 60 * 60_000), JOB_LEASE_MAX_MS);
    // A renew never shortens a lease.
    near(await extended(1), JOB_LEASE_MAX_MS);
    await expect(renew({ attempt: 2 })).resolves.toEqual({ ok: false, reason: "fenced" });
    await expect(renew({ bootId: BOOT2 })).resolves.toEqual({ ok: false, reason: "fenced" });
    await expect(renew({ id: newId("job") })).resolves.toEqual({ ok: false, reason: "gone" });
    await expect(renew({ attempt: 0 })).resolves.toEqual({ ok: false, reason: "fenced" });
    await expect(renew({ id: "not-a-uuid" })).resolves.toEqual({ ok: false, reason: "gone" });
    await expect(
      runner(w, w.otherRunnerId).mutation(api.runnerJobs.renew, {
        jobId,
        bootId: BOOT,
        attempt: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: "gone" });
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", jobId))
        .unique();
      expect(await cancelJob(ctx, row!, T0)).toBe(true);
    });
    await expect(renew({})).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  test("revives a lease that ran out when nothing replaced it", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    const [held] = await claim(w);
    vi.setSystemTime(held!.lease.expiresAt);
    await w.t.mutation(internal.runnerJobs.expireLease, { jobId, attempt: 1 });
    expect((await job(w, jobId))!.status).toBe("queued");
    await expect(
      runner(w).mutation(api.runnerJobs.renew, { jobId, bootId: BOOT, attempt: 1 }),
    ).resolves.toMatchObject({ ok: true, lease: { bootId: BOOT, attempt: 1 } });
    expect(await job(w, jobId)).toMatchObject({
      status: "leased",
      completedAt: null,
      expiresAt: null,
    });
    // Once another lease takes it, the old one is fenced.
    vi.setSystemTime(held!.lease.expiresAt + JOB_LEASE_MS);
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.setSystemTime((await job(w, jobId))!.availableAt);
    expect((await claim(w)).map((c) => c.lease.attempt)).toEqual([2]);
    await expect(
      runner(w).mutation(api.runnerJobs.renew, { jobId, bootId: BOOT, attempt: 1 }),
    ).resolves.toEqual({ ok: false, reason: "fenced" });
  });

  test("a removed member's runner loses its job at the next renew", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await claim(w);
    await leave(w);
    await expect(
      runner(w).mutation(api.runnerJobs.renew, { jobId, bootId: BOOT, attempt: 1 }),
    ).resolves.toEqual({ ok: false, reason: "cancelled" });
    expect(await job(w, jobId)).toMatchObject({
      status: "cancelled",
      failure: expect.objectContaining({ code: "not_a_member" }),
    });
  });
});

describe("runnerJobs.complete", () => {
  test("records done once; a repeat is a duplicate; other leases and runners are refused", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await expect(done(w, jobId)).resolves.toEqual({ ack: "superseded", reason: "fenced" });
    await claim(w);
    await expect(done(w, jobId, 1, OTHER_BOOT)).resolves.toEqual({
      ack: "superseded",
      reason: "fenced",
    });
    await expect(done(w, jobId, 1, BOOT, null)).resolves.toEqual({
      ack: "recorded",
      status: "done",
    });
    const finished = (await job(w, jobId))!;
    expect(finished).toMatchObject({ status: "done", result: null });
    expect(finished.expiresAt).toBe(finished.completedAt! + TERMINAL_JOB_TTL_MS);
    await expect(done(w, jobId)).resolves.toEqual({ ack: "duplicate", status: "done" });
    await expect(failed(w, jobId, 1, false)).resolves.toEqual({ ack: "duplicate", status: "done" });
    await expect(done(w, jobId, 2)).resolves.toEqual({ ack: "superseded", reason: "fenced" });
    await expect(done(w, newId("job"))).resolves.toEqual({ ack: "superseded", reason: "gone" });
    await expect(
      runner(w, w.otherRunnerId).mutation(api.runnerJobs.complete, {
        jobId,
        bootId: BOOT,
        attempt: 1,
        outcome: { status: "done", result: null },
      }),
    ).resolves.toEqual({ ack: "superseded", reason: "gone" });
  });

  test("a cancelled job's completion is superseded", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await claim(w);
    await w.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", jobId))
        .unique())!;
      expect(await cancelJob(ctx, row, T0)).toBe(true);
      expect(await cancelJob(ctx, (await ctx.db.get(row._id))!, T0)).toBe(false);
    });
    expect((await job(w, jobId))!.failure).toMatchObject({ code: "cancelled", by: "backend" });
    await expect(done(w, jobId)).resolves.toEqual({ ack: "superseded", reason: "cancelled" });
  });

  test("a retryable failure goes back to the queue with a backoff, until the last attempt dead-letters it", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    for (let attempt = 1; attempt < JOB_MAX_ATTEMPTS; attempt += 1) {
      const [claimed] = await claim(w);
      expect(claimed!.lease.attempt).toBe(attempt);
      await expect(failed(w, jobId, attempt, true)).resolves.toEqual({
        ack: "recorded",
        status: "queued",
      });
      // The report is idempotent, and the attempt it closed cannot revive.
      await expect(failed(w, jobId, attempt, true)).resolves.toEqual({
        ack: "duplicate",
        status: "queued",
      });
      await expect(done(w, jobId, attempt)).resolves.toEqual({
        ack: "duplicate",
        status: "queued",
      });
      await expect(
        runner(w).mutation(api.runnerJobs.renew, { jobId, bootId: BOOT, attempt }),
      ).resolves.toEqual({ ok: false, reason: "fenced" });
      const row = (await job(w, jobId))!;
      expect(row.failure).toEqual({
        attempt,
        code: "git_failed",
        detail: "exit 128",
        retryable: true,
        by: "runner",
        at: expect.any(Number),
      });
      expect(row.availableAt).toBe(row.failure!.at + retryDelayMs(attempt));
      await expect(claim(w)).resolves.toEqual([]);
      vi.setSystemTime(row.availableAt);
    }
    await claim(w);
    await expect(failed(w, jobId, JOB_MAX_ATTEMPTS, true)).resolves.toEqual({
      ack: "recorded",
      status: "failed",
    });
    expect((await job(w, jobId))!).toMatchObject({ status: "failed", lease: { attempt: 5 } });
  });

  test("a permanent failure dead-letters at once, with its detail bounded", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await claim(w);
    await expect(
      runner(w).mutation(api.runnerJobs.complete, {
        jobId,
        bootId: BOOT,
        attempt: 1,
        outcome: {
          status: "failed",
          code: "unsupported_job_kind",
          detail: "x".repeat(5_000),
          retryable: false,
        },
      }),
    ).resolves.toEqual({ ack: "recorded", status: "failed" });
    const row = (await job(w, jobId))!;
    expect(row.failure!.detail).toHaveLength(2_000);
    expect(row.expiresAt).toBe(row.completedAt! + TERMINAL_JOB_TTL_MS);
    await expect(
      runner(w).mutation(api.runnerJobs.complete, {
        jobId,
        bootId: BOOT,
        attempt: 1,
        outcome: { status: "failed", code: "unsupported_job_kind", detail: null, retryable: false },
      }),
    ).resolves.toEqual({ ack: "duplicate", status: "failed" });
  });

  test("records what a runner cannot deliver as a permanent failure, never an error it would retry", async () => {
    const w = await world();
    const big = await enqueue(w, materialize(w));
    const blank = await enqueue(w, materialize(w));
    await claim(w);
    await expect(
      done(w, big.jobId, 1, BOOT, { body: "x".repeat(JOB_RESULT_MAX_CHARS) }),
    ).resolves.toEqual({ ack: "recorded", status: "failed" });
    expect((await job(w, big.jobId))!.failure).toMatchObject({
      code: "invalid_job_result",
      retryable: false,
      by: "runner",
    });
    await expect(
      runner(w).mutation(api.runnerJobs.complete, {
        jobId: blank.jobId,
        bootId: BOOT,
        attempt: 1,
        outcome: { status: "failed", code: "", detail: null, retryable: false },
      }),
    ).resolves.toEqual({ ack: "recorded", status: "failed" });
    expect((await job(w, blank.jobId))!.failure!.code).toBe("unspecified");
    // A lease reference that cannot name a lease is fenced.
    await expect(done(w, blank.jobId, 1.5)).resolves.toEqual({
      ack: "superseded",
      reason: "fenced",
    });
    await expect(done(w, blank.jobId, 1, "boot")).resolves.toEqual({
      ack: "superseded",
      reason: "fenced",
    });
  });

  test("a late report on an expired job records it, but a retryable failure does not revive it", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await w.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", jobId))
        .unique())!;
      await ctx.db.patch(row._id, {
        status: "expired",
        lease: { bootId: BOOT, attempt: 2, expiresAt: T0 },
      });
    });
    await expect(
      runner(w).mutation(api.runnerJobs.renew, { jobId, bootId: BOOT, attempt: 2 }),
    ).resolves.toEqual({ ok: false, reason: "fenced" });
    await expect(failed(w, jobId, 2, true)).resolves.toEqual({ ack: "recorded", status: "failed" });
  });

  test("records the work even if the owner left the Workspace since", async () => {
    const w = await world();
    const { jobId } = await enqueue(w, materialize(w));
    await claim(w);
    await leave(w);
    await expect(done(w, jobId)).resolves.toEqual({ ack: "recorded", status: "done" });
  });
});

describe("runnerJobs.sweep", () => {
  test("deletes terminal jobs past their keep time and keeps open work", async () => {
    const w = await world();
    const finished = await enqueue(w, materialize(w));
    const open = await enqueue(w, materialize(w));
    await claim(w, { max: 1 });
    await done(w, finished.jobId);
    // A writer that set an expiry on open work never loses it.
    await w.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("runnerJobs")
        .withIndex("by_uuid", (q) => q.eq("id", open.jobId))
        .unique())!;
      await ctx.db.patch(row._id, { expiresAt: T0 });
    });
    await expect(w.t.mutation(internal.runnerJobs.sweep, {})).resolves.toEqual({ deleted: 0 });
    expect((await job(w, open.jobId))!.expiresAt).toBeNull();
    vi.setSystemTime((await job(w, finished.jobId))!.expiresAt!);
    await expect(w.t.mutation(internal.runnerJobs.sweep, {})).resolves.toEqual({ deleted: 1 });
    expect(await job(w, finished.jobId)).toBeNull();
    expect(await job(w, open.jobId)).not.toBeNull();
  });

  test("a full batch schedules the next pass", async () => {
    const w = await world();
    const kinds: JobKind[] = [];
    await w.t.run(async (ctx) => {
      for (let index = 0; index < 257; index += 1) {
        const draft = materialize(w);
        const { jobId } = await enqueueJob(ctx, draft);
        const row = (await ctx.db
          .query("runnerJobs")
          .withIndex("by_uuid", (q) => q.eq("id", jobId))
          .unique())!;
        await ctx.db.patch(row._id, { status: "done", expiresAt: T0 });
        kinds.push(row.kind);
      }
    });
    await expect(w.t.mutation(internal.runnerJobs.sweep, {})).resolves.toEqual({ deleted: 256 });
    await w.t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await w.t.run((ctx) => ctx.db.query("runnerJobs").collect());
    expect(left).toHaveLength(0);
    expect(kinds).toHaveLength(257);
  });
});

test("retry delays grow and cap", () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([
    5_000, 5_000, 20_000, 80_000, 320_000, 600_000, 600_000,
  ]);
});
